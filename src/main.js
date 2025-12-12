const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const PrintSpooler = require('./spooler/PrintSpooler');
const APIServer = require('./api/APIServer');
const ConfigManager = require('./config/ConfigManager');
const ServerClient = require('./client/ServerClient');

let mainWindow;
let printSpooler;
let apiServer;
let configManager;
let serverClient;
// Removed processedServerJobIds - we allow reprocessing since server status updates might not be processed yet

/**
 * Process jobs received from server
 */
async function processServerJobs(jobs) {
  // Check queue status before processing
  const status = printSpooler.getStatus();
  const isQueueFull = status.queueLength >= status.maxQueueSize;
  
  if (isQueueFull) {
    console.warn(`Queue is full (${status.queueLength}/${status.maxQueueSize}). Skipping ${jobs.length} job(s). They will be picked up in the next poll.`);
    return; // Skip processing - jobs will be picked up in next poll when space is available
  }
  
  console.log(`Received ${jobs.length} job(s) from server`);
  
  // Filter out only jobs that are currently in queue (not already processed)
  // We allow reprocessing because server status updates might not have been processed yet
  const existingJobIds = new Set();
  const currentJobs = printSpooler.getJobQueue();
  currentJobs.forEach(job => {
    if (job.serverJobId) {
      existingJobIds.add(job.serverJobId);
    }
  });
  
  const newJobs = jobs.filter(serverJob => {
    if (!serverJob.id) {
      return true; // Process jobs without IDs (shouldn't happen, but be safe)
    }
    
    // Only skip if currently in queue or being processed
    // Allow reprocessing - server might resend jobs until status is updated
    if (existingJobIds.has(serverJob.id)) {
      console.log(`Skipping server job ${serverJob.id} - already in queue or being processed`);
      return false;
    }
    
    return true;
  });
  
  if (newJobs.length === 0) {
    console.log('All jobs from server are already in queue or being processed');
    return;
  }
  
  console.log(`Processing ${newJobs.length} job(s) from server`);
  
  for (const serverJob of newJobs) {
    try {
      // Convert server job format to local job format
      const jobData = {
        pdf: serverJob.pdf,
        pdfBase64: serverJob.pdfBase64,
        pdfPath: serverJob.pdfPath,
        pdfUrl: serverJob.pdfUrl,
        html: serverJob.html,
        url: serverJob.url,
        printerName: serverJob.printerName,
        priority: serverJob.priority || 'normal',
        printBackground: serverJob.printBackground !== false,
        pageSize: serverJob.pageSize || 'A4',
        margins: serverJob.margins,
        copies: serverJob.copies || 1,
        metadata: {
          ...serverJob.metadata,
          serverJobId: serverJob.id,
          fromServer: true
        }
      };

      // Add job to local queue
      const localJob = await printSpooler.addJob(jobData);
      
      // Store mapping between server job ID and local job ID
      if (serverJob.id && localJob.id) {
        localJob.serverJobId = serverJob.id;
        // Don't mark as processed - allow reprocessing if server resends
        // Server will stop sending once status is updated to "printed" or "failed"
        console.log(`Added server job ${serverJob.id} to queue as local job ${localJob.id}`);
      }
    } catch (error) {
      // Handle queue full error specially - don't mark as failed
      if (error.message && error.message.includes('queue is full')) {
        console.warn(`Queue became full while processing jobs. Skipping remaining jobs.`);
        // Don't update server status - job remains pending and will be retried
        break; // Stop processing remaining jobs
      } else {
        // Actual error - log and mark as failed
        console.error('Error processing server job:', error);
        // Send error heartbeat
        if (serverClient) {
          serverClient.sendHeartbeat('error', error.message).catch(err => {
            console.error('Failed to send error heartbeat:', err.message);
          });
        }
        // Update server about the failure
        if (serverJob.id && serverClient) {
          await serverClient.updateJobStatus(serverJob.id, 'failed', error.message);
        }
      }
    }
  }
}

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

  printSpooler.on('job-completed', async (job) => {
    // Update UI
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'completed', job });
    }
    // Update server if this job came from server
    // Use "printed" status for server (mapped from "completed" in updateJobStatus)
    if (job.serverJobId && serverClient) {
      await serverClient.updateJobStatus(job.serverJobId, 'printed');
    }
  });

  printSpooler.on('job-failed', async (job, error) => {
    // Update UI
    if (mainWindow) {
      mainWindow.webContents.send('job-update', { type: 'failed', job, error });
    }
    // Update server if this job came from server
    if (job.serverJobId && serverClient) {
      await serverClient.updateJobStatus(job.serverJobId, 'failed', error.message);
    }
  });
  
  // Initialize API server
  const apiPort = configManager.get('apiPort', 3001);
  apiServer = new APIServer(apiPort, printSpooler);
  apiServer.start();

  // Initialize server client for remote server integration
  serverClient = new ServerClient(configManager);
  
  // Set up server polling callback
  serverClient.startPolling(processServerJobs);
  
  // Start heartbeat mechanism
  serverClient.startHeartbeat();

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
  if (serverClient) {
    serverClient.stop(); // Stops both polling and heartbeat
  }
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
  return printSpooler.getAllJobs(); // Return all jobs including completed ones
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
  
  // If SumatraPDF path is updated, reload it in the print spooler
  if (key === 'sumatraPath' && printSpooler) {
    printSpooler.reloadSumatraPath();
  }
  
  return true;
});

ipcMain.handle('update-server-config', async () => {
  // Restart server client polling with new config
  if (serverClient) {
    serverClient.stop(); // Stop both polling and heartbeat
    serverClient = new ServerClient(configManager);
    
    // Restart polling and heartbeat if server URL is configured
    if (serverClient.isConfigured()) {
      serverClient.startPolling(processServerJobs);
      serverClient.startHeartbeat();
    }
  }
  return true;
});

ipcMain.handle('test-server-connection', async () => {
  if (!serverClient) {
    serverClient = new ServerClient(configManager);
  }
  return await serverClient.testConnection();
});

ipcMain.handle('get-platform', async () => {
  return process.platform;
});

ipcMain.handle('select-sumatra-path', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select SumatraPDF.exe',
      filters: [
        { name: 'Executable Files', extensions: ['exe'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    const selectedPath = result.filePaths[0];
    
    // Validate that it's actually SumatraPDF.exe
    const path = require('path');
    const fileName = path.basename(selectedPath).toLowerCase();
    if (fileName !== 'sumatrapdf.exe' && fileName !== 'sumatrapdf.exe') {
      const { dialog } = require('electron');
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Confirm File Selection',
        message: 'The selected file does not appear to be SumatraPDF.exe',
        detail: `Selected: ${path.basename(selectedPath)}\n\nDo you want to use this file anyway?`,
        buttons: ['Yes', 'No'],
        defaultId: 1
      });
      
      if (confirm.response === 1) {
        return null;
      }
    }
    
    return selectedPath;
  } catch (error) {
    console.error('Error selecting SumatraPDF path:', error);
    throw error;
  }
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

