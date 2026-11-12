import { isProjectLink } from './projectLinks';

describe('the links the desktop app opens in a browser', () => {
  it('are the project’s pages on GitHub', () => {
    expect(isProjectLink('https://github.com/tvinto/tvinto/tree/main/server')).toBe(true);
  });

  it('are nothing else, however it is dressed up', () => {
    for (const url of [
      'https://github.com/someone/tvinto',
      'http://github.com/tvinto/tvinto',
      'https://github.com.evil.example/tvinto/',
      'https://github.com/tvinto/../../evil.example',
      'file:///C:/Windows/System32/calc.exe',
      42
    ]) {
      expect(isProjectLink(url)).toBe(false);
    }
  });
});
