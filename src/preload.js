const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Printer management
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  selectPrinter: () => ipcRenderer.invoke('select-printer'),
  
  // Job management
  getJobs: () => ipcRenderer.invoke('get-jobs'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  retryJob: (jobId) => ipcRenderer.invoke('retry-job', jobId),
  clearCompleted: () => ipcRenderer.invoke('clear-completed'),
  
  // Configuration
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),
  updateServerConfig: () => ipcRenderer.invoke('update-server-config'),
  testServerConnection: () => ipcRenderer.invoke('test-server-connection'),
  
  // Listen for job updates
  onJobUpdate: (callback) => {
    ipcRenderer.on('job-update', (event, data) => callback(data));
  },
  
  // Remove listeners
  removeJobUpdateListener: () => {
    ipcRenderer.removeAllListeners('job-update');
  }
});

