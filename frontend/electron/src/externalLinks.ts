import { ipcMain, shell } from 'electron';
import { fromAppPage } from './appPage';
import { isProjectLink } from './projectLinks';

/**
 * Opening a page in the person's own browser, for the app's page. Only the
 * project's own pages (projectLinks.ts says which those are).
 */
export const registerExternalLinks = (): void => {
  ipcMain.handle('xtream:open-external', async (event, url: unknown) => {
    if (!fromAppPage(event) || !isProjectLink(url)) {
      return false;
    }
    await shell.openExternal(url);
    return true;
  });
};
