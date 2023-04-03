import { program } from 'commander';
import fs from 'fs';
import pkg from 'enquirer';
const { prompt } = pkg;
import { authorize, listDriveFolders, selectDriveFolder, syncFolder } from '../lib/google-drive-sync.js';
import { TOKEN_PATH, CLIENT_SECRET_PATH, SCOPES } from '../lib/constants.js';

program.version('1.0.0');

program
  .command('drivefolderlist')
  .description('List all the folders in Google Drive')
  .action(async () => {
    const auth = await authorize();
    const folders = await listDriveFolders(auth);
    console.log('Folders in Google Drive:');
    console.table(folders);
  });

program
  .command('selectdrivefolder')
  .description('Select a folder in Google Drive to sync with')
  .action(async () => {
    const auth = await authorize();
    const folders = await listDriveFolders(auth);
    const { folderName } = await prompt({
      type: 'select',
      name: 'folderName',
      message: 'Select a folder to sync with:',
      choices: folders.map((folder) => folder.name),
    });
    const selectedFolder = folders.find((folder) => folder.name === folderName);
    if (!selectedFolder) {
      console.error(`Folder '${folderName}' not found in Google Drive`);
      process.exit(1);
    }
    console.log(`Selected folder: ${selectedFolder.name} (${selectedFolder.id})`);
  });

program
  .command('sync <localFolderPath>')
  .description('Sync a local folder with the selected folder in Google Drive')
  .action(async (localFolderPath) => {
    const auth = await authorize();
    const selectedFolder = await selectDriveFolder(auth);
    await syncFolder(localFolderPath, selectedFolder.id);
    console.log(`Synced '${localFolderPath}' with '${selectedFolder.name}' in Google Drive`);
  });


program
  .command('logout')
  .description('Logout of the current Google Drive session')
  .action(async () => {
    const auth = await authorize();
    const { confirmLogout } = await prompt({
      type: 'confirm',
      name: 'confirmLogout',
      message: 'Are you sure you want to logout of the current Google Drive session?',
    });
    if (confirmLogout) {
      auth.credentials = null;
      fs.unlinkSync(TOKEN_PATH);
      console.log('Successfully logged out of Google Drive session');
    } else {
      console.log('Logout cancelled');
    }
  });

program.parse(process.argv);
