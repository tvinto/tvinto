const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join, resolve } = require('path');

/**
 * Running wrangler from a release script, on Windows, without lying about it.
 *
 * Two things went wrong here and both were silent, which is why this is its own
 * file rather than four lines copied into two scripts.
 *
 * **`npx.cmd` cannot be spawned directly.** Node refuses to execute `.bat` and
 * `.cmd` files without a shell -- it has done since the argument-injection fix
 * in Node 18.20 -- and the refusal arrives as `error` on the result rather than
 * as a non-zero exit code. So wrangler is run as what it actually is: a
 * JavaScript file, run by the Node already running this.
 *
 * **A failure has to say what it was.** The first version checked `status !== 0`
 * and printed its own sentence, so a spawn that never started at all reported
 * "uploading failed" with nothing about why -- and the same command pasted into
 * a terminal worked perfectly.
 */

/** Where wrangler is installed, and where its configuration and account live. */
const WORKER = resolve(__dirname, '../../worker');

/**
 * The file, found by looking rather than by asking.
 *
 * `require.resolve('wrangler/bin/wrangler.js')` is refused: the package's
 * `exports` map does not list it, and Node honours that even for a path that
 * plainly exists. Nothing here is importing wrangler as a library -- it is a
 * program that happens to be written in JavaScript, and this is where it is.
 */
const wranglerScript = () => {
  const script = join(WORKER, 'node_modules/wrangler/bin/wrangler.js');

  if (!existsSync(script)) {
    throw new Error(`No wrangler in ${WORKER}. Run \`npm install\` there.`);
  }

  return script;
};

/**
 * Runs wrangler and returns what happened.
 *
 * `{ ok: true }`, or `{ ok: false, why }` with something worth reading in it.
 */
const runWrangler = args => {
  let result;

  try {
    result = spawnSync(process.execPath, [wranglerScript(), ...args], {
      cwd: WORKER,
      stdio: 'inherit'
    });
  } catch (failure) {
    return { ok: false, why: failure.message };
  }

  if (result.error) {
    return { ok: false, why: result.error.message };
  }

  if (result.status !== 0) {
    return { ok: false, why: `wrangler exited with ${result.status}` };
  }

  return { ok: true };
};

/**
 * Puts one local file into the update bucket, with one second go.
 *
 * A hundred-megabyte upload answered `401: Unauthorized` once and worked
 * immediately afterwards with the same token, which is a refresh losing a race
 * rather than anything being wrong. Once, and no more: a second failure is a
 * failure, and a script that keeps trying is a script that hides one.
 */
const putObject = (bucket, name, file, contentType) => {
  const first = putOnce(bucket, name, file, contentType);
  if (first.ok) {
    return first;
  }

  console.log(`  ${name} did not go (${first.why}). Trying once more.`);
  return putOnce(bucket, name, file, contentType);
};

const putOnce = (bucket, name, file, contentType) =>
  runWrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${name}`,
    '--file',
    file,
    '--content-type',
    contentType,
    // Without this, wrangler writes to the local simulator on this machine and
    // reports success. The upload would have gone nowhere.
    '--remote'
  ]);

module.exports = { runWrangler, putObject, WORKER };
