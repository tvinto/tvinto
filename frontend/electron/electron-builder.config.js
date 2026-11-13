/**
 * How the desktop app is packaged, and where it looks for its own updates.
 *
 * JavaScript rather than JSON because every setting below is a decision, and a
 * JSON file has nowhere to say why. electron-builder reads either.
 *
 * The two that matter:
 *
 * - `appId` is the app's identity to Windows. It was the scaffold's
 *   `com.yourdoamnin.yourapp` (their typo) until the first packaged build, and
 *   changing it after a release would make the next installer look like a
 *   different program and install alongside rather than over. Changed now,
 *   while nothing is installed anywhere.
 * - `publish` is baked into the build as `app-update.yml`. An installed copy
 *   therefore carries its own idea of where updates come from, and nothing it
 *   downloads can change that.
 */

/**
 * Where the app asks for new versions: the project's feed on GitHub Releases,
 * or `updatesUrl` in `frontend/config.local.json` for a fork or a sync
 * service's own bucket (`frontend/scripts/feed.js`, which the publish scripts
 * read too, so a build and its release always agree).
 */
const UPDATE_URL = require('../scripts/feed').updatesUrl();

module.exports = {
  appId: 'app.tvinto',
  productName: 'Tvinto',

  directories: {
    buildResources: 'resources'
  },

  files: ['assets/**/*', 'build/**/*', 'capacitor.config.*', 'app/**/*'],

  /**
   * mpv, shipped beside the app rather than looked for on the machine.
   *
   * The reason the desktop build exists at all: Chromium has no HEVC decoder
   * unless Windows supplies one, and most of this provider's films are 4K
   * HEVC. Until now mpv was found on the PATH or in Program Files, which is
   * fine for running from source and useless for an installer — somebody who
   * installs this has not installed mpv, and the app would quietly fall back
   * to the in-page player and give them sound over a black picture.
   *
   * `extraResources` rather than `files`: it lands in the app's own resources
   * directory unpacked, which is where `findMpv` looks first and the only
   * place an executable can be launched from. Inside the asar it could not be
   * run at all.
   *
   * `scripts/fetch-mpv.js` puts it there, pinned and hash-checked. It is 115 MB
   * and not in the repository.
   */
  extraResources: [
    { from: 'resources/mpv', to: 'mpv' },
    /**
     * tvinto, the command-line tool and MCP server, so that connecting an AI
     * agent needs neither Node nor the source: the app's own executable runs
     * it (src/toolCli.ts). One bundled file, built by `npm run build:cli`,
     * and the credential store's native module beside it, which is the one
     * thing the bundle leaves out. Node-API, so the same binary loads in
     * Electron's runtime as in Node's.
     */
    { from: '../../cli/dist/tvinto.js', to: 'cli/tvinto.js' },
    { from: '../../cli/node_modules/@napi-rs/keyring', to: 'cli/node_modules/@napi-rs/keyring', filter: ['**/*', '!*.d.ts'] },
    { from: '../../cli/node_modules/@napi-rs/keyring-win32-x64-msvc', to: 'cli/node_modules/@napi-rs/keyring-win32-x64-msvc' }
  ],

  publish: {
    /**
     * `generic` on GitHub too, rather than electron-builder's `github`
     * provider: that one asks GitHub's API, which allows sixty requests an
     * hour per address, and finds the newest release rather than the feed --
     * which on this project may be a web bundle. The feed release's
     * `latest.yml` names each installer by its full address.
     */
    provider: 'generic',
    url: UPDATE_URL,
    /**
     * One range per request when downloading only the changed blocks.
     *
     * The default asks for many ranges at once and expects a multipart reply,
     * which neither the Worker nor GitHub does -- both answer one `bytes=a-b`
     * (GitHub refuses several with 501).
     * Left at the default, a differential download would get an answer it
     * cannot parse, and the fallback for that is downloading the whole
     * installer: it would work, quietly, and be slower every time.
     */
    useMultipleRangeRequest: false
  },

  // `${productName}` has no spaces in it, which is what keeps this a URL that
  // needs no escaping in a YAML file that nothing sensible escapes.
  artifactName: '${productName}-Setup-${version}.${ext}',

  win: {
    target: 'nsis',
    icon: 'assets/appIcon.ico'
  },

  nsis: {
    oneClick: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    /**
     * Installed for this user rather than for the machine.
     *
     * The reason is the update, not the install: a per-machine install needs
     * administrator rights to replace, so every silent update would raise a
     * UAC prompt on a machine that may be across the room and driven by a
     * remote. Per-user needs nothing.
     */
    perMachine: false
  }

  // No mac or linux target. The desktop build exists because Windows is where
  // the television PC is; adding a target nobody builds would only mean a
  // configuration nobody has ever run.
};
