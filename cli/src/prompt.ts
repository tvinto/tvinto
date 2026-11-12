/**
 * Asking a person for the username and password, at a terminal.
 *
 * Never from an argument, an environment variable or a pipe: an argument is
 * in the shell's history and every process listing, and a pipe is how an
 * agent would type a password it should never have seen. No
 * password ever passes through an agent's context.
 */

export interface Terminal {
  isTTY: boolean;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

/** The process's own terminal. */
export const processTerminal = (): Terminal => ({
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),

  ask: question =>
    new Promise(resolve => {
      process.stdout.write(question);
      let answer = '';
      const stdin = process.stdin;
      stdin.setEncoding('utf8');
      const onData = (chunk: string) => {
        answer += chunk;
        const end = answer.search(/\r?\n/);
        if (end >= 0) {
          stdin.off('data', onData);
          stdin.pause();
          resolve(answer.slice(0, end).trim());
        }
      };
      stdin.resume();
      stdin.on('data', onData);
    }),

  askHidden: question =>
    new Promise((resolve, reject) => {
      process.stdout.write(question);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      let answer = '';
      const finish = () => {
        stdin.setRawMode(false);
        stdin.off('data', onData);
        stdin.pause();
        process.stdout.write('\n');
      };
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') {
            finish();
            resolve(answer);
            return;
          }
          if (character === '\u0003') {
            finish();
            reject(new Error('Cancelled'));
            return;
          }
          if (character === '\u007f' || character === '\b') {
            answer = answer.slice(0, -1);
          } else if (character >= ' ') {
            answer += character;
          }
        }
      };
      stdin.resume();
      stdin.on('data', onData);
    })
});
