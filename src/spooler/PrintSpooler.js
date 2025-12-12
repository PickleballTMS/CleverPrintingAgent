const { EventEmitter } = require('events');
const { webContents } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class PrintSpooler extends EventEmitter {
  constructor(configManager) {
    super();
    this.configManager = configManager;
    this.jobQueue = [];
    this.jobHistory = []; // Store completed/failed/cancelled jobs for UI display
    this.currentJob = null;
    this.isProcessing = false;
    this.defaultPrinter = configManager.get('defaultPrinter', null);
    this.sumatraPath = configManager.get('sumatraPath', null);
    this.maxRetries = configManager.get('maxRetries', 3);
    this.retryDelay = configManager.get('retryDelay', 5000); // 5 seconds
    this.maxQueueSize = configManager.get('maxQueueSize', 100);
  }

  /**
   * Resolve SumatraPDF path (Windows only, prefer user-configured)
   */
  getSumatraPath() {
    if (process.platform !== 'win32') return null;

    // 1) User-configured system installation (preferred)
    if (this.sumatraPath) {
      try {
        if (fs.existsSync(this.sumatraPath)) {
          return this.sumatraPath;
        } else {
          console.warn('Configured SumatraPDF path does not exist:', this.sumatraPath);
        }
      } catch {}
    }

    // 2) Bundled / fallback locations
    const candidates = [
      path.join(process.resourcesPath || '', 'sumatra', 'SumatraPDF.exe'),
      path.join(__dirname, '..', '..', 'assets', 'windows', 'sumatra', 'SumatraPDF.exe'),
      path.join(process.cwd(), 'sumatra', 'SumatraPDF.exe')
    ];

    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          return p;
        }
      } catch {}
    }

    return null;
  }

  /**
   * Get all available printers
   */
  async getAvailablePrinters() {
    // Create a hidden window to access printer list
    const { BrowserWindow } = require('electron');
    const tempWindow = new BrowserWindow({ show: false });
    
    return new Promise((resolve) => {
      let resolved = false;
      
      const getPrinters = async () => {
        try {
          let printers = [];
          
          // Check what methods are available
          console.log('Checking available printer methods...');
          console.log('getPrintersAsync:', typeof tempWindow.webContents.getPrintersAsync);
          console.log('getPrinters:', typeof tempWindow.webContents.getPrinters);
          
          // Try async method first (Electron 8+)
          if (typeof tempWindow.webContents.getPrintersAsync === 'function') {
            console.log('Using getPrintersAsync()');
            printers = await tempWindow.webContents.getPrintersAsync();
            console.log('getPrintersAsync returned:', printers?.length || 0, 'printers');
          }
          // Try sync method (older Electron versions)
          else if (typeof tempWindow.webContents.getPrinters === 'function') {
            console.log('Using getPrinters()');
            printers = tempWindow.webContents.getPrinters();
            console.log('getPrinters returned:', printers?.length || 0, 'printers');
          }
          // Fallback: use system commands
          else {
            console.warn('Electron API not available, using fallback method to detect printers');
            printers = this.getPrintersFallback();
          }
          
          // If still no printers, try fallback
          if (!printers || printers.length === 0) {
            console.log('No printers found via Electron API, trying fallback...');
            const fallbackPrinters = this.getPrintersFallback();
            if (fallbackPrinters && fallbackPrinters.length > 0) {
              printers = fallbackPrinters;
            }
          }
          
          resolved = true;
          tempWindow.close();
          
          // Normalize printer objects to ensure they have name/displayName
          const normalizedPrinters = (printers || []).map(printer => {
            // Handle different printer object structures
            const name = printer.name || printer.displayName || printer.description || 'Unknown Printer';
            return {
              name: name,
              displayName: printer.displayName || printer.name || name,
              description: printer.description || printer.name || '',
              status: printer.status || 0,
              isDefault: printer.isDefault || false
            };
          });
          
          console.log(`Found ${normalizedPrinters.length} printer(s):`, normalizedPrinters.map(p => p.name));
          resolve(normalizedPrinters);
        } catch (error) {
          console.error('Error getting printers:', error);
          resolved = true;
          tempWindow.close();
          
          // Try fallback method
          try {
            const fallbackPrinters = this.getPrintersFallback();
            resolve(fallbackPrinters || []);
          } catch (fallbackError) {
            console.error('Fallback method also failed:', fallbackError);
            resolve([]);
          }
        }
      };
      
      tempWindow.webContents.once('did-finish-load', () => {
        getPrinters();
      });
      
      tempWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('Failed to load window for printer detection:', errorDescription);
        if (!resolved) {
          resolved = true;
          tempWindow.close();
          // Try fallback
          try {
            const fallbackPrinters = this.getPrintersFallback();
            resolve(fallbackPrinters || []);
          } catch (error) {
            resolve([]);
          }
        }
      });
      
      // Load a blank page to ensure webContents is ready
      tempWindow.loadURL('data:text/html,<html><body></body></html>');
      
      // Timeout fallback
      setTimeout(() => {
        if (!resolved && !tempWindow.isDestroyed()) {
          console.warn('Printer detection timeout, trying fallback');
          resolved = true;
          tempWindow.close();
          try {
            const fallbackPrinters = this.getPrintersFallback();
            resolve(fallbackPrinters || []);
          } catch (error) {
            resolve([]);
          }
        }
      }, 5000);
    });
  }

  /**
   * Fallback method to get printers using system commands
   */
  getPrintersFallback() {
    const { execSync } = require('child_process');
    const printers = [];
    const printerNames = new Set();
    
    try {
      if (process.platform === 'darwin') {
        // macOS: use lpstat -p to get printer list
        try {
          const output = execSync('lpstat -p 2>/dev/null', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
          const lines = output.split('\n').filter(line => line.trim());
          
          lines.forEach(line => {
            // Parse "printer PrinterName is idle" format
            const match = line.match(/^printer\s+(\S+)\s+/);
            if (match && match[1]) {
              const name = match[1];
              if (!printerNames.has(name)) {
                printerNames.add(name);
                printers.push({
                  name: name,
                  displayName: name,
                  description: '',
                  status: 0,
                  isDefault: false
                });
              }
            }
          });
        } catch (error) {
          console.warn('lpstat -p failed, trying lpstat -a:', error.message);
        }
        
        // If no printers found, try lpstat -a (available printers)
        if (printers.length === 0) {
          try {
            const output = execSync('lpstat -a 2>/dev/null', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            const lines = output.split('\n').filter(line => line.trim());
            
            lines.forEach(line => {
              // Parse "PrinterName accepting requests" format
              const match = line.match(/^(\S+)\s+accepting/);
              if (match && match[1]) {
                const name = match[1];
                if (!printerNames.has(name)) {
                  printerNames.add(name);
                  printers.push({
                    name: name,
                    displayName: name,
                    description: '',
                    status: 0,
                    isDefault: false
                  });
                }
              }
            });
          } catch (error) {
            console.warn('lpstat -a also failed:', error.message);
          }
        }
        
        // Also try system_profiler for macOS
        if (printers.length === 0) {
          try {
            const output = execSync('system_profiler SPPrintersDataType 2>/dev/null | grep "Printer Name"', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
            const lines = output.split('\n').filter(line => line.trim());
            lines.forEach(line => {
              const match = line.match(/Printer Name:\s*(.+)/);
              if (match && match[1]) {
                const name = match[1].trim();
                if (name && !printerNames.has(name)) {
                  printerNames.add(name);
                  printers.push({
                    name: name,
                    displayName: name,
                    description: '',
                    status: 0,
                    isDefault: false
                  });
                }
              }
            });
          } catch (error) {
            console.warn('system_profiler failed:', error.message);
          }
        }
      } else if (process.platform === 'win32') {
        // Windows: use wmic
        try {
          const output = execSync('wmic printer get name /value', { encoding: 'utf8' });
          const lines = output.split('\n').filter(line => line.trim() && line.includes('Name='));
          lines.forEach(line => {
            const name = line.replace('Name=', '').trim();
            if (name) {
              printers.push({
                name: name,
                displayName: name,
                description: '',
                status: 0,
                isDefault: false
              });
            }
          });
        } catch (error) {
          console.warn('Windows printer detection failed:', error.message);
        }
      } else {
        // Linux: use lpstat
        try {
          const output = execSync('lpstat -p 2>/dev/null || lpstat -a 2>/dev/null', { encoding: 'utf8' });
          const lines = output.split('\n').filter(line => line.trim());
          const printerNames = new Set();
          
          lines.forEach(line => {
            const match = line.match(/^printer\s+(\S+)|^(\S+)\s+accepting/);
            if (match) {
              const name = match[1] || match[2];
              if (name && !printerNames.has(name)) {
                printerNames.add(name);
                printers.push({
                  name: name,
                  displayName: name,
                  description: '',
                  status: 0,
                  isDefault: false
                });
              }
            }
          });
        } catch (error) {
          console.warn('Linux printer detection failed:', error.message);
        }
      }
    } catch (error) {
      console.warn('Fallback printer detection failed:', error.message);
    }
    
    return printers;
  }

  /**
   * Set the default printer
   */
  setDefaultPrinter(printerName) {
    this.defaultPrinter = printerName;
    this.configManager.set('defaultPrinter', printerName);
  }

  /**
   * Reload SumatraPDF path from config (called when config is updated)
   */
  reloadSumatraPath() {
    this.sumatraPath = this.configManager.get('sumatraPath', null);
  }

  /**
   * Add a print job to the queue
   */
  async addJob(jobData) {
    const job = {
      id: this.generateJobId(),
      timestamp: new Date().toISOString(),
      status: 'queued',
      priority: jobData.priority || 'normal',
      data: jobData,
      retryCount: 0,
      error: null
    };

    // Check queue size limit
    if (this.jobQueue.length >= this.maxQueueSize) {
      throw new Error('Print queue is full. Please wait for jobs to complete.');
    }

    this.jobQueue.push(job);
    this.emit('job-added', job);
    
    // Start processing if not already processing
    if (!this.isProcessing) {
      this.processQueue();
    }

    return job;
  }

  /**
   * Process the print queue
   */
  async processQueue() {
    if (this.isProcessing || this.jobQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.jobQueue.length > 0) {
      // Sort by priority: high > normal > low
      this.jobQueue.sort((a, b) => {
        const priorityOrder = { high: 3, normal: 2, low: 1 };
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      });

      this.currentJob = this.jobQueue.shift();
      this.currentJob.status = 'processing';
      this.emit('job-updated', this.currentJob);

      try {
        // Update status to "printing" when actually starting to print
        this.currentJob.status = 'printing';
        this.emit('job-updated', this.currentJob);
        
        await this.executePrint(this.currentJob);
        this.currentJob.status = 'completed';
        // Move completed job to history
        this.jobHistory.push({ ...this.currentJob });
        this.emit('job-completed', this.currentJob);
      } catch (error) {
        console.error('Print job failed:', error);
        this.currentJob.error = error.message;
        
        // Retry logic
        if (this.currentJob.retryCount < this.maxRetries) {
          this.currentJob.retryCount++;
          this.currentJob.status = 'queued';
          this.jobQueue.unshift(this.currentJob); // Add back to front of queue
          this.emit('job-updated', this.currentJob);
          
          // Wait before retry
          await this.sleep(this.retryDelay);
        } else {
          this.currentJob.status = 'failed';
          // Move failed job to history
          this.jobHistory.push({ ...this.currentJob });
          this.emit('job-failed', this.currentJob, error);
        }
      }

      this.currentJob = null;
    }

    this.isProcessing = false;
  }

  /**
   * Execute the actual print job
   */
  async executePrint(job) {
    return new Promise(async (resolve, reject) => {
      const { BrowserWindow } = require('electron');
      let timeoutHandle = null;

      // Handle PDF files (priority)
      if (job.data.pdf || job.data.pdfBase64 || job.data.pdfPath || job.data.pdfUrl) {
        // For PDF files, we need to ensure we have a file path
        // If we have pdfPath directly, use it; otherwise load/save to get a file path
        let pdfFilePath = null;
        
        if (job.data.pdfPath && fs.existsSync(job.data.pdfPath)) {
          // Direct file path - use it
          pdfFilePath = job.data.pdfPath;
        } else {
          // Need to load/save PDF to get a file path
          // This handles pdfBase64, pdf, and pdfUrl
          try {
            await this.loadPDFForPrinting(null, job.data); // Pass null - we don't need BrowserWindow
            pdfFilePath = job.data._tempPdfPath || job.data.pdfPath;
          } catch (error) {
            reject(error);
            return;
          }
        }
        
        if (!pdfFilePath || !fs.existsSync(pdfFilePath)) {
          reject(new Error('PDF file path not available or file does not exist'));
          return;
        }
        
        // Use hidden BrowserWindow with plugins enabled so Chromium PDF viewer renders the PDF
        const printWindow = new BrowserWindow({
          show: false,
          webPreferences: {
            plugins: true
          }
        });
        this.loadPDFForPrinting(printWindow, job.data)
          .then(() => {
            // PDF has its own timeout handler in printPDF, so we don't need one here
            this.printPDF(printWindow, job.data, resolve, reject);
          })
          .catch((error) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            printWindow.close();
            reject(error);
          });
        return;
      }

      // Handle HTML content (legacy support)
      if (job.data.html) {
        printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(job.data.html)}`);
      } else if (job.data.url) {
        printWindow.loadURL(job.data.url);
      } else {
        printWindow.close();
        reject(new Error('No print content provided'));
        return;
      }

      printWindow.webContents.once('did-finish-load', () => {
        const options = {
          silent: false,
          printBackground: job.data.printBackground !== false,
          deviceName: job.data.printerName || this.defaultPrinter || undefined,
          pageSize: job.data.pageSize || 'A4',
          margins: job.data.margins || {
            marginType: 'default'
          },
          copies: job.data.copies || 1
        };

        printWindow.webContents.on('did-stop-loading', () => {
          console.log('PDF fully stopped loading');
        });

        printWindow.webContents.print(options, (success, failureReason) => {
          printWindow.close();
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          
          if (success) {
            resolve();
          } else {
            reject(new Error(failureReason || 'Print failed'));
          }
        });
      });

      printWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        printWindow.close();
        reject(new Error(`Failed to load content: ${errorDescription}`));
      });

      // Timeout after 30 seconds (only for HTML/URL content, not PDFs)
      timeoutHandle = setTimeout(() => {
        if (!printWindow.isDestroyed()) {
          printWindow.close();
          reject(new Error('Print job timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Load PDF for printing
   */
  async loadPDFForPrinting(printWindow, jobData) {
    return new Promise((resolve, reject) => {
      // Determine PDF source
      let pdfPath = null;
      let pdfData = null;

      if (jobData.pdfPath) {
        // Local file path
        if (fs.existsSync(jobData.pdfPath)) {
          pdfPath = jobData.pdfPath;
        } else {
          reject(new Error(`PDF file not found: ${jobData.pdfPath}`));
          return;
        }
      } else if (jobData.pdfBase64 || jobData.pdf) {
        // Base64 encoded PDF - save to temp file
        try {
          const base64Data = jobData.pdfBase64 || jobData.pdf;
          // Remove data URL prefix if present
          const base64 = base64Data.replace(/^data:application\/pdf;base64,/, '');
          pdfData = Buffer.from(base64, 'base64');
          
          // Save to temporary file
          const tempDir = app.getPath('temp');
          const tempFileName = `print_job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
          pdfPath = path.join(tempDir, tempFileName);
          
          // Write PDF file - ensure we're writing binary data correctly
          // Use 'binary' encoding flag to ensure no text encoding issues
          fs.writeFileSync(pdfPath, pdfData, { encoding: null, flag: 'w' });
          
          // Verify the written file matches what we intended to write
          const writtenBuffer = fs.readFileSync(pdfPath);
          if (writtenBuffer.length !== pdfData.length) {
            console.error('PDF file size mismatch after write!');
            console.error('  - Expected:', pdfData.length, 'bytes');
            console.error('  - Written:', writtenBuffer.length, 'bytes');
          }
          
          // Ensure file has read permissions (not execute - not needed for PDFs)
          // 0o644 = rw-r--r-- (read/write for owner, read for group/others)
          try {
            fs.chmodSync(pdfPath, 0o644);
          } catch (chmodError) {
            // chmod may fail on some systems, but file should still be readable
            console.warn('Could not set file permissions (file should still be readable):', chmodError.message);
          }
          
          // Store temp file path for cleanup
          jobData._tempPdfPath = pdfPath;
          console.log('PDF saved successfully:', pdfPath, '(' + pdfData.length + ' bytes)');
        } catch (error) {
          reject(new Error(`Failed to process PDF data: ${error.message}`));
          return;
        }
      } else if (jobData.pdfUrl) {
        // URL to PDF - download and save to temp file
        const https = require('https');
        const http = require('http');
        const url = require('url');
        
        const parsedUrl = new url.URL(jobData.pdfUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        
        let downloadTimeout = null;
        const req = client.get(jobData.pdfUrl, (response) => {
          if (response.statusCode !== 200) {
            if (downloadTimeout) clearTimeout(downloadTimeout);
            reject(new Error(`Failed to download PDF: HTTP ${response.statusCode}`));
            return;
          }
          
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            if (downloadTimeout) clearTimeout(downloadTimeout);
            try {
              pdfData = Buffer.concat(chunks);
              const tempDir = app.getPath('temp');
              const tempFileName = `print_job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
              pdfPath = path.join(tempDir, tempFileName);
              console.log('Saving PDF to:', pdfPath);
              // Write PDF file - ensure we're writing binary data correctly
              fs.writeFileSync(pdfPath, pdfData, { encoding: null, flag: 'w' });
              
              // Verify the written file
              const writtenBuffer = fs.readFileSync(pdfPath);
              if (writtenBuffer.length !== pdfData.length) {
                console.error('PDF file size mismatch after write!');
                console.error('  - Expected:', pdfData.length, 'bytes');
                console.error('  - Written:', writtenBuffer.length, 'bytes');
              }
              
              // Ensure file has read permissions (not execute - not needed for PDFs)
              // 0o644 = rw-r--r-- (read/write for owner, read for group/others)
              try {
                fs.chmodSync(pdfPath, 0o644);
              } catch (chmodError) {
                // chmod may fail on some systems, but file should still be readable
                console.warn('Could not set file permissions (file should still be readable):', chmodError.message);
              }
              jobData._tempPdfPath = pdfPath;
              console.log('PDF downloaded and saved successfully:', pdfPath, '(' + pdfData.length + ' bytes)');
              resolve();
            } catch (error) {
              reject(new Error(`Failed to save downloaded PDF: ${error.message}`));
            }
          });
        });
        
        req.on('error', (error) => {
          if (downloadTimeout) clearTimeout(downloadTimeout);
          reject(new Error(`Failed to download PDF: ${error.message}`));
        });
        
        // Set timeout for download (30 seconds)
        downloadTimeout = setTimeout(() => {
          req.destroy();
          reject(new Error('PDF download timeout - download took too long'));
        }, 30000);
        
        return;
      } else {
        reject(new Error('No valid PDF source provided'));
        return;
      }

      // Load PDF file (only if printWindow is provided)
      if (pdfPath) {
        // If no printWindow provided, we're just getting the file path - resolve immediately
        if (!printWindow) {
          resolve();
          return;
        }
        
        // Use file:// protocol to load PDF into BrowserWindow
        const fileUrl = `file://${pdfPath}`;
        let loadTimeout = null;
        
        printWindow.loadURL(fileUrl);
        
        printWindow.webContents.once('dom-ready', () => {
          // Chromium PDF viewer needs extra time to fully render
          setTimeout(() => {
            if (loadTimeout) clearTimeout(loadTimeout);
            resolve();
          }, 1500);
        });
        
        printWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
          if (loadTimeout) clearTimeout(loadTimeout);
          reject(new Error(`Failed to load PDF: ${errorDescription}`));
        });
        
        // Timeout for loading PDF (20 seconds should be enough)
        loadTimeout = setTimeout(() => {
          reject(new Error('PDF load timeout - PDF took too long to load'));
        }, 20000);
      }
    });
  }

  /**
   * Print PDF
   */
  printPDF(printWindow, jobData, resolve, reject) {
    const { exec } = require('child_process');

    const pdfPath = jobData._tempPdfPath || jobData.pdfPath;

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      if (!printWindow.isDestroyed()) {
        printWindow.close();
      }
      reject(new Error('PDF file not found for printing'));
      return;
    }

    const platform = process.platform;
    let command = '';

    try {
      if (platform === 'darwin' || platform === 'linux') {
        // macOS / Linux → CUPS (lp)
        const printer = jobData.printerName || this.defaultPrinter;
        const copies = jobData.copies || 1;

        command = printer
          ? `lp -d "${printer}" -n ${copies} "${pdfPath}"`
          : `lp -n ${copies} "${pdfPath}"`;
      }
      else if (platform === 'win32') {
        // Windows → Prefer SumatraPDF (if bundled), fallback to Edge kiosk

        const escapedPath = pdfPath.replace(/'/g, "''");
        const sumatra = this.getSumatraPath();

        if (sumatra) {
          console.log('Using SumatraPDF for printing:', sumatra);

          const printer = jobData.printerName || this.defaultPrinter;

          command = printer
            ? `"${sumatra}" -silent -print-to "${printer}" -print-settings "fit,center,paper=auto,bin=auto" "${pdfPath}"`
            : `"${sumatra}" -silent -print-to-default -print-settings "fit,center,paper=auto,bin=auto" "${pdfPath}"`;
        } else {
          console.warn('SumatraPDF not found, falling back to Edge kiosk printing');

          command =
            `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
            `"try { ` +
              `Start-Process -FilePath '${escapedPath}' -Verb Print -WindowStyle Hidden -ErrorAction Stop; ` +
            `} catch { ` +
              `$p = Start-Process 'msedge.exe' ` +
                `-ArgumentList '--kiosk-printing','--print-to-default-printer','${escapedPath}' ` +
                `-WindowStyle Hidden -PassThru; ` +
              `Start-Sleep -Seconds 5; ` +
              `if ($p -and !$p.HasExited) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 1; if (!$p.HasExited) { Stop-Process -Id $p.Id -Force } } ` +
            `}"`;
        }
      }
      else {
        throw new Error(`Unsupported platform: ${platform}`);
      }

      console.log('Executing native print command:', command);

      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('Native print failed:', stderr || error.message);
          if (!printWindow.isDestroyed()) {
            printWindow.close();
          }
          reject(new Error(stderr || error.message));
          return;
        }

        // Cleanup temp file
        if (jobData._tempPdfPath && fs.existsSync(jobData._tempPdfPath)) {
          try { fs.unlinkSync(jobData._tempPdfPath); } catch {}
        }

        if (!printWindow.isDestroyed()) {
          printWindow.close();
        }

        resolve();
      });
    } catch (err) {
      if (!printWindow.isDestroyed()) {
        printWindow.close();
      }
      reject(err);
    }
  }

  /**
   * Get the current job queue
   */
  getJobQueue() {
    const queue = [...this.jobQueue];
    if (this.currentJob) {
      queue.unshift(this.currentJob);
    }
    return queue;
  }

  /**
   * Get all jobs (including completed/failed from history)
   */
  getAllJobs() {
    const activeJobs = this.getJobQueue();
    // Combine active jobs with history, removing duplicates by ID
    const allJobsMap = new Map();
    
    // Add history jobs first (older)
    this.jobHistory.forEach(job => {
      allJobsMap.set(job.id, job);
    });
    
    // Add/update with active jobs (newer, may override history if job was retried)
    activeJobs.forEach(job => {
      allJobsMap.set(job.id, job);
    });
    
    // Convert to array and sort by timestamp (newest first)
    return Array.from(allJobsMap.values()).sort((a, b) => {
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId) {
    const jobIndex = this.jobQueue.findIndex(j => j.id === jobId);
    if (jobIndex !== -1) {
      const job = this.jobQueue.splice(jobIndex, 1)[0];
      job.status = 'cancelled';
      // Move cancelled job to history
      this.jobHistory.push({ ...job });
      this.emit('job-updated', job);
      return true;
    }
    
    if (this.currentJob && this.currentJob.id === jobId) {
      this.currentJob.status = 'cancelled';
      // Move cancelled job to history
      this.jobHistory.push({ ...this.currentJob });
      this.emit('job-updated', this.currentJob);
      this.currentJob = null;
      // Continue processing queue
      setImmediate(() => this.processQueue());
      return true;
    }
    
    return false;
  }

  /**
   * Retry a failed job
   */
  async retryJob(jobId) {
    // This would need to track completed/failed jobs separately
    // For now, we'll just reset retry count if job is still in queue
    const job = this.jobQueue.find(j => j.id === jobId) || 
                (this.currentJob && this.currentJob.id === jobId ? this.currentJob : null);
    
    if (job && job.status === 'failed') {
      job.status = 'queued';
      job.retryCount = 0;
      job.error = null;
      if (!this.jobQueue.includes(job)) {
        this.jobQueue.push(job);
      }
      this.emit('job-updated', job);
      
      if (!this.isProcessing) {
        this.processQueue();
      }
      return true;
    }
    
    return false;
  }

  /**
   * Clear completed jobs from history
   */
  clearCompletedJobs() {
    const initialLength = this.jobHistory.length;
    // Remove completed jobs from history (keep failed/cancelled for reference)
    this.jobHistory = this.jobHistory.filter(job => job.status !== 'completed');
    return initialLength - this.jobHistory.length;
  }

  /**
   * Get spooler status
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.jobQueue.length,
      maxQueueSize: this.maxQueueSize,
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        status: this.currentJob.status
      } : null,
      defaultPrinter: this.defaultPrinter
    };
  }

  /**
   * Generate a unique job ID
   */
  generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the spooler
   */
  shutdown() {
    this.isProcessing = false;
    // Wait for current job to complete or timeout
    return new Promise((resolve) => {
      if (!this.currentJob) {
        resolve();
      } else {
        setTimeout(() => {
          resolve();
        }, 5000);
      }
    });
  }
}

module.exports = PrintSpooler;

