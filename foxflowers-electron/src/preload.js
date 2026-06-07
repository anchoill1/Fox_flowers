const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('foxAPI', {
  getSetting:      (key)        => ipcRenderer.invoke('get-setting', key),
  setSetting:      (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getUploadsDir:   ()           => ipcRenderer.invoke('get-uploads-dir'),
  listImages:      ()           => ipcRenderer.invoke('list-images'),
  saveImage:       (data)       => ipcRenderer.invoke('save-image', data),
  deleteImage:     (filename)   => ipcRenderer.invoke('delete-image', filename),
  readImageBase64: (filename)   => ipcRenderer.invoke('read-image-base64', filename),
  scanInvoice:     (data)       => ipcRenderer.invoke('scan-invoice', data),
  saveCSV:         (content)    => ipcRenderer.invoke('save-csv', content),
  saveXlsx:        (data)       => ipcRenderer.invoke('save-xlsx', data),
  markDone:        (filenames)  => ipcRenderer.invoke('mark-done', filenames),
});
