const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const PrintSpooler = require('./spooler/PrintSpooler');
const APIServer = require('./api/APIServer');
const ConfigManager = require('./config/ConfigManager');

let mainWindow;
let printSpooler;
let apiServer;
let configManager;

function createWindow() {
  const isMac = process.platform === 'darwin';
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    ...(isMac && {
      titleBarStyle: 'hiddenInset', // macOS: hide title bar but keep native buttons
      titleBarOverlay: {
        color: '#2563eb', // Gradient start color (solid, closest to gradient)
        symbolColor: '#ffffff' // White symbols for native buttons
      }
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    backgroundColor: '#2563eb' // Match gradient start color
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Initialize configuration manager
  configManager = new ConfigManager();
  
  // Initialize print spooler
  printSpooler = new PrintSpooler(configManager);
  
  // Set up event listeners for print job updates
  printSpooler.on('job-added', (job) => {
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'added', job });
    }
  });

  printSpooler.on('job-updated', (job) => {
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'updated', job });
    }
  });

  printSpooler.on('job-completed', (job) => {
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'completed', job });
    }
  });

  printSpooler.on('job-failed', (job, error) => {
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'failed', job, error });
    }
  });
  
  // Initialize API server
  const apiPort = configManager.get('apiPort', 3001);
  apiServer = new APIServer(apiPort, printSpooler);
  apiServer.start();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (printSpooler) {
    printSpooler.shutdown();
  }
  if (apiServer) {
    apiServer.stop();
  }
});

// IPC Handlers
ipcMain.handle('get-printers', async () => {
  return await printSpooler.getAvailablePrinters();
});

ipcMain.handle('get-jobs', async () => {
  return printSpooler.getJobQueue();
});

ipcMain.handle('get-status', async () => {
  return printSpooler.getStatus();
});

ipcMain.handle('cancel-job', async (event, jobId) => {
  return await printSpooler.cancelJob(jobId);
});

ipcMain.handle('retry-job', async (event, jobId) => {
  return await printSpooler.retryJob(jobId);
});

ipcMain.handle('clear-completed', async () => {
  return printSpooler.clearCompletedJobs();
});

ipcMain.handle('get-config', async () => {
  return configManager.getAll();
});

ipcMain.handle('set-config', async (event, key, value) => {
  configManager.set(key, value);
  return true;
});

ipcMain.handle('select-printer', async () => {
  try {
    const printers = await printSpooler.getAvailablePrinters();
    
    // Check if any printers are available
    if (!printers || printers.length === 0) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'No Printers Found',
        message: 'No printers are available on this system.',
        buttons: ['OK']
      });
      return null;
    }
    
    // Create buttons array with Cancel option
    const printerNames = printers.map(p => p.name || p.displayName || 'Unknown Printer');
    const buttons = [...printerNames, 'Cancel'];
    
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: buttons,
      defaultId: buttons.length - 1, // Default to Cancel
      cancelId: buttons.length - 1,
      title: 'Select Default Printer',
      message: 'Choose a default printer for print jobs',
      detail: `${printers.length} printer(s) available`
    });
    
    // Check if Cancel was clicked or if response is invalid
    if (result.response === buttons.length - 1 || result.canceled || result.response >= printers.length) {
      return null;
    }
    
    const selectedPrinter = printers[result.response];
    if (selectedPrinter) {
      const printerName = selectedPrinter.name || selectedPrinter.displayName;
      configManager.set('defaultPrinter', printerName);
      printSpooler.setDefaultPrinter(printerName);
      return selectedPrinter;
    }
    
    return null;
  } catch (error) {
    console.error('Error in select-printer:', error);
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Error',
      message: 'Failed to select printer',
      detail: error.message || 'An unknown error occurred',
      buttons: ['OK']
    });
    throw error;
  }
});

