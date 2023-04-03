import { createReadStream, createWriteStream } from 'fs';
import { basename } from 'path';
import { google } from 'googleapis';
// import { drive } from 'googleapis/build/src/apis/drive';
import readline from 'readline';
// import { authenticate } from './auth';

import { TOKEN_PATH, CLIENT_SECRET_PATH, SCOPES } from './constants.js';
import { readFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline';


var workingAuth = null;
// const driveClient = google.drive('v3');

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const EXCLUDED_FOLDERS = ['node_modules']; // Add any folders to exclude from syncing here


async function createDriveFolder(name, parentFolderId = null) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  const fileMetadata = {
    name: name,
    mimeType: FOLDER_MIME_TYPE,
  };

  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId];
  }

  const res = await drive.files.create({
    resource: fileMetadata,
    fields: 'id, name',
  });

  return res.data.id;
}

async function uploadFileToDrive(filePath, folderId) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  const fileMetadata = {
    name: basename(filePath),
    parents: [folderId],
  };

  const media = {
    mimeType: 'application/octet-stream',
    body: createReadStream(filePath),
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, modifiedTime',
  });

  console.log(`File uploaded: ${res.data.name} (${res.data.id})`);
}

async function downloadFileFromDrive(fileId, filePath) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  const dest = createWriteStream(filePath);
  const res = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    res.data
      .on('end', () => {
        console.log(`File downloaded: ${filePath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error(`Error downloading file: ${err}`);
        reject(err);
      })
      .pipe(dest);
  });
}

async function deleteFileFromDrive(fileId) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  await drive.files.delete({ fileId: fileId });

  console.log(`File deleted: ${fileId}`);
}

async function deleteFolderFromDrive(folderId) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  await drive.files.delete({ fileId: folderId });

  console.log(`Folder deleted: ${folderId}`);
}

async function getFilesInFolder(folderId) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });

  const query = `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({
    q: query,
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
  });

  return res.data.files;
}

/**
 * Returns an array of file and folder objects for the files in the specified folder path.
 * @param {string} folderPath - The path to the folder to read.
 * @returns {Promise<Object[]>} - An array of file and folder objects.
 */
async function readFolder(folderPath) {
  return new Promise((resolve, reject) => {
    fs.readdir(folderPath, { withFileTypes: true }, (err, files) => {
      if (err) {
        reject(err);
      } else {
        const fileObjects = files.map((file) => {
          const filePath = `${folderPath}/${file.name}`;
          return {
            name: file.name,
            path: filePath,
            isDirectory: () => file.isDirectory(),
            modifiedTime: fs.statSync(filePath).mtime.toISOString(),
          };
        });
        resolve(fileObjects);
      }
    });
  });
}

/**
 * Returns an array of file objects for the files in the specified Google Drive folder ID.
 * @param {string} folderId - The ID of the Google Drive folder to get files from.
 * @returns {Promise<Object[]>} - An array of file objects.
 */
async function getDriveFiles(folderId) {
  const drive = google.drive({ version: 'v3', auth: workingAuth });
  const response = await drive.files.list({
    q: `'${folderId}' in parents`,
    fields: 'files(id, name, mimeType, modifiedTime)',
  });
  return response.data.files;
}

/**
 * Updates the specified file in Google Drive with the contents of the specified local file.
 * @param {Object} localFile - The file object for the local file to upload.
 * @param {string} fileId - The ID of the Google Drive file to update.
 * @returns {Promise<void>} - A Promise that resolves when the update is complete.
 */
async function updateDriveFile(localFile, fileId) {
  const media = {
    mimeType: localFile.mimeType,
    body: fs.createReadStream(localFile.path),
  };
  const drive = google.drive({ version: 'v3', auth: workingAuth });
  await drive.files.update({
    fileId,
    media,
  });
}

async function syncFolder(localFolderPath, driveParentFolderId = null) {
  const folderName = basename(localFolderPath);

  // Check if folder exists in drive and create if not
  const driveFolderId = await checkDriveFolderExistsOrCreate(folderName, driveParentFolderId);

  // Get local files and folders
  const localFiles = await readFolder(localFolderPath);

  // Get drive files and folders
  const driveFiles = await getDriveFiles(driveFolderId);

  // Create a set of local file names for easy comparison
  const localFileNames = new Set(localFiles.map((file) => file.name));

  // Sync each local file
  for (const localFile of localFiles) {
    if (localFileNames.has(localFile.name)) {
      // File exists locally and may need to be synced
      const driveFile = driveFiles.find((file) => file.name === localFile.name);
      if (driveFile) {
        // File exists in drive, check if it needs to be updated
        const localModifiedTime = new Date(localFile.modifiedTime).getTime();
        const driveModifiedTime = new Date(driveFile.modifiedTime).getTime();
        if (localModifiedTime > driveModifiedTime) {
          // Local file has been modified more recently, upload to drive
          console.log(`Updating file: ${localFile.name}`);
          await updateDriveFile(localFile, driveFile.id);
        }
      } else {
        // File does not exist in drive, upload it
        console.log(`Uploading file: ${localFile.name}`);
        await uploadToDrive(localFile, driveFolderId);
      }
    }
  }

  // Sync each drive file
  for (const driveFile of driveFiles) {
    if (!localFileNames.has(driveFile.name)) {
      // File exists in drive but not locally, delete it from drive
      console.log(`Deleting file: ${driveFile.name}`);
      await deleteFromDrive(driveFile.id);
    }
  }

  // Recursively sync each local folder
  const localFolders = localFiles.filter((file) => file.isDirectory() && file.name !== 'node_modules');

  for (const localFolder of localFolders) {
    console.log(`Syncing folder: ${localFolder.name}`);
    await syncFolder(localFolder.path, driveFolderId);
  }
}


async function authorize() {
  const credentials = await readFile(CLIENT_SECRET_PATH, { encoding: 'utf8' })
  // const credentials = await readFile('./credentials.json')
  .catch((err) => {
    console.error('Failed to read credentials file:', err);
    process.exit(1);
  });
  const { client_secret, client_id, redirect_uris } = JSON.parse(credentials).installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  try {
    const token = await readFile(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    workingAuth = oAuth2Client;
    return oAuth2Client;
  } catch (err) {
    return getNewToken(oAuth2Client);
  }
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve, reject) => {
    rl.question('Enter the code from that page here: ', async (code) => {
      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        await writeFile(TOKEN_PATH, JSON.stringify(tokens));
        console.log('Token stored to', TOKEN_PATH);
        workingAuth = oAuth2Client;
        resolve(oAuth2Client);
      } catch (err) {
        reject(err);
      } finally {
        rl.close();
      }
    });
  });
}

async function listDriveFolders(oAuth2Client) {
  const drive = google.drive({ version: 'v3', auth: oAuth2Client });
  const query = "mimeType='application/vnd.google-apps.folder' and trashed = false";
  const res = await drive.files.list({
    q: query,
    fields: 'nextPageToken, files(id, name)',
  });
  return res.data.files;
}

async function selectDriveFolder() {
  const driveFolders = await listDriveFolders();
  const folderNames = driveFolders.map((folder) => folder.name);
  const { folder } = await inquirer.prompt([
    {
      type: 'list',
      name: 'folder',
      message: 'Select a folder to sync with:',
      choices: folderNames,
    },
  ]);
  return driveFolders.find((folder) => folder.name === folder).id;
}

export { authorize, syncFolder, selectDriveFolder, listDriveFolders };