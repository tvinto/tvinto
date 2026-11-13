/*
 * tvinto-player: mpv drawing into textures the app's window shows.
 *
 * mpv.exe draws into a window of its own, which the page cannot put anything
 * over. This is the same mpv (libmpv-2.dll, the same build as mpv.exe) with
 * its video drawn into D3D11 textures instead. The textures are shared with
 * Electron's main process, which hands each frame to the page as a VideoFrame
 * (Electron's sharedTexture), and the page draws it under its own controls.
 *
 * Everything else is mpv as it was: the same options on the command line, the
 * same JSON pipe (`--input-ipc-server`), the same commands, the same exit
 * codes. Sound goes from here to Windows, as from mpv.exe.
 *
 *   tvinto-player.exe --tvinto-parent=<pid> [--tvinto-size=WxH] [mpv options] -- <address>
 *
 * Talking to the main process, one line each way:
 *
 *   stdout  pool <generation> <width> <height> <handle> <handle> <handle>
 *             Three textures, their NT handles already duplicated into the
 *             parent process (decimal).
 *           frame <generation> <index> <width> <height>
 *             That texture holds a finished frame. It is not drawn into again
 *             until the main process frees it.
 *           log <text>
 *   stdin   free <generation> <index>     The page is done with that texture.
 *           size <width> <height>          Draw at this size from now on.
 *           retire <generation>            No more imports from that pool: its
 *                                          handles in the parent may be closed.
 *           quit                           As mpv's `quit`.
 *
 * libmpv cannot report the code `quit 4` was given (mpv.exe exits with it).
 * The app sets `user-data/tvinto-exit` before quitting, which this reads.
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <d3d11.h>
#include <d3d11_3.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <type_traits>
#include <vector>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_d3d11.h>

namespace {

constexpr int POOL_SIZE = 3;

// ---------------------------------------------------------------- libmpv

struct Mpv {
  HMODULE dll = nullptr;
  decltype(&mpv_create) create;
  decltype(&mpv_initialize) initialize;
  decltype(&mpv_set_option_string) set_option_string;
  decltype(&mpv_command) command;
  decltype(&mpv_wait_event) wait_event;
  decltype(&mpv_get_property_string) get_property_string;
  decltype(&mpv_free) free;
  decltype(&mpv_error_string) error_string;
  decltype(&mpv_terminate_destroy) terminate_destroy;
  decltype(&mpv_wakeup) wakeup;
  decltype(&mpv_render_context_create) render_create;
  decltype(&mpv_render_context_set_update_callback) render_set_update_callback;
  decltype(&mpv_render_context_update) render_update;
  decltype(&mpv_render_context_render) render_render;
  decltype(&mpv_render_context_report_swap) render_report_swap;
  decltype(&mpv_render_context_free) render_free;

  bool load(const std::wstring &folder) {
    dll = LoadLibraryExW((folder + L"\\libmpv-2.dll").c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!dll) {
      return false;
    }
    bool ok = true;
    auto get = [&](auto &slot, const char *name) {
      slot = reinterpret_cast<std::remove_reference_t<decltype(slot)>>(GetProcAddress(dll, name));
      ok = ok && slot != nullptr;
    };
    get(create, "mpv_create");
    get(initialize, "mpv_initialize");
    get(set_option_string, "mpv_set_option_string");
    get(command, "mpv_command");
    get(wait_event, "mpv_wait_event");
    get(get_property_string, "mpv_get_property_string");
    get(free, "mpv_free");
    get(error_string, "mpv_error_string");
    get(terminate_destroy, "mpv_terminate_destroy");
    get(wakeup, "mpv_wakeup");
    get(render_create, "mpv_render_context_create");
    get(render_set_update_callback, "mpv_render_context_set_update_callback");
    get(render_update, "mpv_render_context_update");
    get(render_render, "mpv_render_context_render");
    get(render_report_swap, "mpv_render_context_report_swap");
    get(render_free, "mpv_render_context_free");
    return ok;
  }
} mpv;

// ---------------------------------------------------------------- output

std::mutex outLock;

void say(const std::string &line) {
  std::lock_guard<std::mutex> hold(outLock);
  std::string text = line + "\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
}

std::string utf8(const wchar_t *wide) {
  int size = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  std::string out(size > 0 ? size - 1 : 0, '\0');
  if (size > 1) {
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), size, nullptr, nullptr);
  }
  return out;
}

// ---------------------------------------------------------------- textures

struct Pool {
  int generation = 0;
  int width = 0;
  int height = 0;
  ID3D11Texture2D *textures[POOL_SIZE] = {};
  HANDLE remote[POOL_SIZE] = {};
  bool busy[POOL_SIZE] = {};
  bool retired = false;
};

ID3D11Device *device = nullptr;
ID3D11DeviceContext *context = nullptr;
ID3D11Query *done = nullptr;
// Waiting for the GPU without spinning (Windows 10): a fence that sets an event.
ID3D11Fence *fence = nullptr;
ID3D11DeviceContext4 *context4 = nullptr;
HANDLE fenceDone = nullptr;
UINT64 fenceValue = 0;
HANDLE parent = nullptr;

std::mutex poolLock;
std::vector<Pool *> pools;  // The newest last; older ones until every texture is back.
int wantedWidth = 1920;
int wantedHeight = 1080;
int nextGeneration = 1;

HANDLE wake = nullptr;  // Set by mpv (a frame to draw), by a texture freed, by a size.
std::atomic<bool> stopping{false};
std::atomic<bool> redraw{false};  // Draw the current frame again (a new size), even paused.

bool createDevice() {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1,
                                      D3D_FEATURE_LEVEL_10_0};
  // The default adapter, which is the one Chromium uses too: a texture shared
  // between two adapters cannot be opened by the other.
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, levels,
                                 ARRAYSIZE(levels), D3D11_SDK_VERSION, &device, nullptr, &context);
  if (FAILED(hr)) {
    say("log no D3D11 device: " + std::to_string(hr));
    return false;
  }
  ID3D11Device5 *device5 = nullptr;
  if (SUCCEEDED(device->QueryInterface(__uuidof(ID3D11Device5), reinterpret_cast<void **>(&device5))) &&
      SUCCEEDED(context->QueryInterface(__uuidof(ID3D11DeviceContext4), reinterpret_cast<void **>(&context4))) &&
      SUCCEEDED(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, __uuidof(ID3D11Fence), reinterpret_cast<void **>(&fence)))) {
    fenceDone = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  }
  if (device5) {
    device5->Release();
  }
  D3D11_QUERY_DESC desc = {D3D11_QUERY_EVENT, 0};
  return SUCCEEDED(device->CreateQuery(&desc, &done));
}

/** Three textures at the wanted size, shared with the parent. Under poolLock. */
Pool *makePool() {
  auto *pool = new Pool();
  pool->generation = nextGeneration++;
  pool->width = wantedWidth;
  pool->height = wantedHeight;

  D3D11_TEXTURE2D_DESC desc = {};
  desc.Width = pool->width;
  desc.Height = pool->height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;

  std::string line = "pool " + std::to_string(pool->generation) + " " + std::to_string(pool->width) + " " +
                     std::to_string(pool->height);
  for (int i = 0; i < POOL_SIZE; i++) {
    IDXGIResource1 *resource = nullptr;
    HANDLE local = nullptr;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, &pool->textures[i])) ||
        FAILED(pool->textures[i]->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void **>(&resource))) ||
        FAILED(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr,
                                            &local)) ||
        !DuplicateHandle(GetCurrentProcess(), local, parent, &pool->remote[i], 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      say("log could not share a texture");
    }
    if (local) {
      CloseHandle(local);
    }
    if (resource) {
      resource->Release();
    }
    line += " " + std::to_string(reinterpret_cast<uintptr_t>(pool->remote[i]));
  }
  pools.push_back(pool);
  say(line);
  return pool;
}

/** Lets go of pools nobody is using any more. Under poolLock. */
void tidyPools() {
  for (size_t at = 0; at + 1 < pools.size();) {
    Pool *pool = pools[at];
    bool inUse = false;
    for (bool busy : pool->busy) {
      inUse = inUse || busy;
    }
    if (inUse || !pool->retired) {
      at++;
      continue;
    }
    for (int i = 0; i < POOL_SIZE; i++) {
      if (pool->remote[i]) {
        // Closed in the parent, where it lives.
        DuplicateHandle(parent, pool->remote[i], nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
      }
      if (pool->textures[i]) {
        pool->textures[i]->Release();
      }
    }
    delete pool;
    pools.erase(pools.begin() + at);
  }
}

// ---------------------------------------------------------------- drawing

mpv_handle *player = nullptr;
mpv_render_context *renderer = nullptr;
std::atomic<long long> framesSent{0};
std::atomic<long long> framesWaited{0};

void onUpdate(void *) { SetEvent(wake); }

DWORD WINAPI drawLoop(void *) {
  bool pendingFrame = false;
  while (!stopping) {
    WaitForSingleObject(wake, 100);
    if (stopping) {
      break;
    }
    uint64_t flags = mpv.render_update(renderer);
    pendingFrame = pendingFrame || (flags & MPV_RENDER_UPDATE_FRAME) || redraw.exchange(false);
    if (!pendingFrame) {
      continue;
    }

    Pool *pool = nullptr;
    int index = -1;
    {
      std::lock_guard<std::mutex> hold(poolLock);
      if (pools.empty() || pools.back()->width != wantedWidth || pools.back()->height != wantedHeight) {
        makePool();
      }
      pool = pools.back();
      for (int i = 0; i < POOL_SIZE; i++) {
        if (!pool->busy[i]) {
          index = i;
          break;
        }
      }
      if (index >= 0) {
        pool->busy[index] = true;
      }
    }
    if (index < 0) {
      // Every texture is still with the page. Waits for one to come back
      // (wake is set when it does) rather than drawing over a frame on screen.
      framesWaited++;
      continue;
    }

    pendingFrame = false;
    mpv_d3d11_fbo target = {pool->textures[index]};
    mpv_render_param params[] = {{MPV_RENDER_PARAM_D3D11_FBO, &target}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    mpv.render_render(renderer, params);

    // Finished on the GPU before the other side may read it: no keyed mutex
    // on a bgra texture Electron imports, so the work is waited for here.
    if (fence && fenceDone) {
      context4->Signal(fence, ++fenceValue);
      context->Flush();
      fence->SetEventOnCompletion(fenceValue, fenceDone);
      WaitForSingleObject(fenceDone, 1000);
    } else {
      context->End(done);
      context->Flush();
      while (context->GetData(done, nullptr, 0, 0) == S_FALSE) {
        Sleep(1);
      }
    }
    mpv.render_report_swap(renderer);

    framesSent++;
    say("frame " + std::to_string(pool->generation) + " " + std::to_string(index) + " " +
        std::to_string(pool->width) + " " + std::to_string(pool->height));
  }
  return 0;
}

// ---------------------------------------------------------------- control

void handle(const std::string &line) {
  int a = 0, b = 0;
  if (sscanf(line.c_str(), "free %d %d", &a, &b) == 2) {
    std::lock_guard<std::mutex> hold(poolLock);
    for (Pool *pool : pools) {
      if (pool->generation == a && b >= 0 && b < POOL_SIZE) {
        pool->busy[b] = false;
      }
    }
    tidyPools();
    SetEvent(wake);
  } else if (sscanf(line.c_str(), "size %d %d", &a, &b) == 2) {
    if (a >= 16 && b >= 16 && a <= 8192 && b <= 8192) {
      std::lock_guard<std::mutex> hold(poolLock);
      wantedWidth = a;
      wantedHeight = b;
    }
    // Drawn again at the new size, paused or not.
    redraw = true;
    SetEvent(wake);
  } else if (sscanf(line.c_str(), "retire %d", &a) == 1) {
    std::lock_guard<std::mutex> hold(poolLock);
    for (Pool *pool : pools) {
      if (pool->generation <= a && pool != pools.back()) {
        pool->retired = true;
      }
    }
    tidyPools();
  } else if (line == "quit") {
    const char *quit[] = {"quit", nullptr};
    mpv.command(player, quit);
  }
}

DWORD WINAPI readControl(void *) {
  std::string buffer;
  char chunk[512];
  DWORD got = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), chunk, sizeof chunk, &got, nullptr) && got > 0) {
    buffer.append(chunk, got);
    for (size_t end; (end = buffer.find('\n')) != std::string::npos;) {
      std::string line = buffer.substr(0, end);
      buffer.erase(0, end + 1);
      if (!line.empty() && line.back() == '\r') {
        line.pop_back();
      }
      handle(line);
    }
  }
  // The app closed its end: it is gone or done with us.
  const char *quit[] = {"quit", nullptr};
  mpv.command(player, quit);
  return 0;
}

DWORD WINAPI watchParent(void *) {
  WaitForSingleObject(parent, INFINITE);
  // The app went without saying so. Holding the provider's one connection
  // with nobody watching is the thing not to do.
  ExitProcess(3);
}

// ---------------------------------------------------------------- options

/** `--name=value`, `--no-name` and `--name` as mpv.exe reads them. */
bool setOption(const std::string &argument) {
  std::string body = argument.substr(2);
  std::string name = body, value = "yes";
  size_t equals = body.find('=');
  if (equals != std::string::npos) {
    name = body.substr(0, equals);
    value = body.substr(equals + 1);
  } else if (body.rfind("no-", 0) == 0) {
    name = body.substr(3);
    value = "no";
  }
  // A window's options mean nothing without a window.
  static const char *windowOnly[] = {"border", "ontop", "screen", "geometry", "fullscreen", "fs", "force-window",
                                     "terminal", "title"};
  for (const char *skip : windowOnly) {
    if (name == skip) {
      return true;
    }
  }
  int error = mpv.set_option_string(player, name.c_str(), value.c_str());
  if (error < 0) {
    say("log option " + name + ": " + mpv.error_string(error));
  }
  return error >= 0;
}

}  // namespace

// wWinMain, built for the Windows subsystem: a console program started by the
// app (which has no console) would open a console window on the screen.
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int count = 0;
  wchar_t **wide = CommandLineToArgvW(GetCommandLineW(), &count);
  std::vector<std::string> args;
  for (int i = 1; i < count; i++) {
    args.push_back(utf8(wide[i]));
  }

  wchar_t self[MAX_PATH];
  GetModuleFileNameW(nullptr, self, MAX_PATH);
  std::wstring folder(self);
  folder = folder.substr(0, folder.find_last_of(L"\\/"));

  DWORD parentId = 0;
  for (const std::string &arg : args) {
    if (arg.rfind("--tvinto-parent=", 0) == 0) {
      parentId = static_cast<DWORD>(strtoul(arg.c_str() + 16, nullptr, 10));
    } else if (arg.rfind("--tvinto-size=", 0) == 0) {
      sscanf(arg.c_str() + 14, "%dx%d", &wantedWidth, &wantedHeight);
    }
  }

  // --tvinto-check: whether this machine can play this way at all (a D3D11
  // device, libmpv, its D3D11 renderer), asked once before the first play.
  bool checkOnly = false;
  for (const std::string &arg : args) {
    checkOnly = checkOnly || arg == "--tvinto-check";
  }
  parent = checkOnly ? GetCurrentProcess() : OpenProcess(PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, parentId);
  if (!parent) {
    say("log no parent process");
    return 1;
  }
  if (!mpv.load(folder)) {
    say("log no libmpv-2.dll beside the helper");
    return 1;
  }
  if (!createDevice()) {
    return 1;
  }

  player = mpv.create();
  if (!player) {
    return 1;
  }
  // As mpv.exe behaves: quits after its files unless --idle says not to, keys
  // bound the default way and from --input-conf (the app presses them over
  // the pipe), and no window of its own.
  mpv.set_option_string(player, "vo", "libmpv");
  // Idle inside libmpv always: with idle=no it shuts down before the first
  // loadfile below arrives. Quitting after the files, as mpv.exe does without
  // --idle, is done here (MPV_EVENT_IDLE).
  mpv.set_option_string(player, "idle", "yes");
  mpv.set_option_string(player, "input-default-bindings", "yes");
  mpv.set_option_string(player, "hwdec", "auto-safe");

  std::vector<std::string> files;
  bool idle = false;
  bool afterDashes = false;
  for (const std::string &arg : args) {
    if (afterDashes) {
      files.push_back(arg);
    } else if (arg == "--") {
      afterDashes = true;
    } else if (arg.rfind("--tvinto-", 0) == 0) {
      continue;
    } else if (arg == "--idle" || arg.rfind("--idle=", 0) == 0) {
      idle = arg == "--idle" || arg == "--idle=yes" || arg == "--idle=once";
    } else if (arg.rfind("--", 0) == 0) {
      setOption(arg);
    }
  }

  if (mpv.initialize(player) < 0) {
    say("log mpv would not start");
    return 1;
  }

  mpv_d3d11_init_params init = {device};
  mpv_render_param params[] = {{MPV_RENDER_PARAM_API_TYPE, const_cast<char *>(MPV_RENDER_API_TYPE_D3D11)},
                               {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init},
                               {MPV_RENDER_PARAM_INVALID, nullptr}};
  int made = mpv.render_create(&renderer, player, params);
  if (made < 0) {
    say(std::string("log no D3D11 render context: ") + mpv.error_string(made));
    return 1;
  }
  if (checkOnly) {
    mpv.render_free(renderer);
    mpv.terminate_destroy(player);
    say("log ready");
    return 0;
  }

  wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  mpv.render_set_update_callback(renderer, onUpdate, nullptr);
  HANDLE drawing = CreateThread(nullptr, 0, drawLoop, nullptr, 0, nullptr);
  CreateThread(nullptr, 0, readControl, nullptr, 0, nullptr);
  CreateThread(nullptr, 0, watchParent, nullptr, 0, nullptr);

  for (const std::string &file : files) {
    const char *load[] = {"loadfile", file.c_str(), "append-play", nullptr};
    mpv.command(player, load);
  }

  // As mpv.exe counts them: 0 when anything played to an ordinary end, 2 when
  // every file failed, 3 when some did.
  int endedWell = 0;
  int endedBadly = 0;
  bool anyFile = false;
  long long lastStats = GetTickCount64();
  for (;;) {
    mpv_event *event = mpv.wait_event(player, 1.0);
    if (event->event_id == MPV_EVENT_SHUTDOWN) {
      break;
    }
    if (event->event_id == MPV_EVENT_END_FILE) {
      auto *ended = static_cast<mpv_event_end_file *>(event->data);
      if (ended->reason == MPV_END_FILE_REASON_ERROR) {
        endedBadly++;
      } else if (ended->reason != MPV_END_FILE_REASON_REDIRECT) {
        endedWell++;
      }
    } else if (event->event_id == MPV_EVENT_START_FILE) {
      anyFile = true;
    } else if (event->event_id == MPV_EVENT_IDLE && anyFile && !idle) {
      const char *quit[] = {"quit", nullptr};
      mpv.command(player, quit);
    }
    if (GetTickCount64() - lastStats > 5000) {
      lastStats = GetTickCount64();
      say("log stats sent=" + std::to_string(framesSent.load()) + " waited=" + std::to_string(framesWaited.load()));
    }
  }

  int code = endedBadly == 0 ? 0 : endedWell == 0 ? 2 : 3;
  if (char *asked = mpv.get_property_string(player, "user-data/tvinto-exit")) {
    code = atoi(asked);
    mpv.free(asked);
  }

  stopping = true;
  SetEvent(wake);
  WaitForSingleObject(drawing, 2000);
  mpv.render_free(renderer);
  mpv.terminate_destroy(player);
  return code;
}
