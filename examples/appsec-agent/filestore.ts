// fileReader.js
import * as fs from 'fs';
import * as path from 'path';

function readFilesInDirectory(
  directoryPath: fs.PathLike,
  fileMap: Map<any, any>,
) {
  const files = fs.readdirSync(directoryPath);

  files.forEach((file) => {
    const filePath = path.join(directoryPath as any, file);

    if (fs.statSync(filePath).isDirectory()) {
      readFilesInDirectory(filePath, fileMap);
    } else {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      fileMap.set(file, fileContent);
    }
  });
}

const loadFiles = (directoryPath: string) => {
  const fileMap = new Map();

  readFilesInDirectory(directoryPath, fileMap);

  return fileMap;
};

export { loadFiles };
