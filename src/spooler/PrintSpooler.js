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
    this.currentJob = null;
    this.isProcessing = false;
    this.defaultPrinter = configManager.get('defaultPrinter', null);
    this.maxRetries = configManager.get('maxRetries', 3);
    this.retryDelay = configManager.get('retryDelay', 5000); // 5 seconds
    this.maxQueueSize = configManager.get('maxQueueSize', 100);
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
        await this.executePrint(this.currentJob);
        this.currentJob.status = 'completed';
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
    return new Promise((resolve, reject) => {
      const { BrowserWindow } = require('electron');
      const printWindow = new BrowserWindow({ show: false });

      // Handle PDF files (priority)
      if (job.data.pdf || job.data.pdfBase64 || job.data.pdfPath || job.data.pdfUrl) {
        this.loadPDFForPrinting(printWindow, job.data)
          .then(() => {
            this.printPDF(printWindow, job.data, resolve, reject);
          })
          .catch(reject);
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
          silent: true,
          printBackground: job.data.printBackground !== false,
          deviceName: job.data.printerName || this.defaultPrinter || undefined,
          pageSize: job.data.pageSize || 'A4',
          margins: job.data.margins || {
            marginType: 'default'
          },
          copies: job.data.copies || 1
        };

        printWindow.webContents.print(options, (success, failureReason) => {
          printWindow.close();
          
          if (success) {
            resolve();
          } else {
            reject(new Error(failureReason || 'Print failed'));
          }
        });
      });

      printWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
        printWindow.close();
        reject(new Error(`Failed to load content: ${errorDescription}`));
      });

      // Timeout after 30 seconds
      setTimeout(() => {
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
          
          fs.writeFileSync(pdfPath, pdfData);
          // Store temp file path for cleanup
          jobData._tempPdfPath = pdfPath;
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
        
        client.get(jobData.pdfUrl, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download PDF: HTTP ${response.statusCode}`));
            return;
          }
          
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            try {
              pdfData = Buffer.concat(chunks);
              const tempDir = app.getPath('temp');
              const tempFileName = `print_job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
              pdfPath = path.join(tempDir, tempFileName);
              
              fs.writeFileSync(pdfPath, pdfData);
              jobData._tempPdfPath = pdfPath;
              resolve();
            } catch (error) {
              reject(new Error(`Failed to save downloaded PDF: ${error.message}`));
            }
          });
        }).on('error', (error) => {
          reject(new Error(`Failed to download PDF: ${error.message}`));
        });
        return;
      } else {
        reject(new Error('No valid PDF source provided'));
        return;
      }

      // Load PDF file
      if (pdfPath) {
        // Use file:// protocol to load PDF
        const fileUrl = `file://${pdfPath}`;
        printWindow.loadURL(fileUrl);
        
        printWindow.webContents.once('did-finish-load', () => {
          resolve();
        });
        
        printWindow.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
          reject(new Error(`Failed to load PDF: ${errorDescription}`));
        });
      }
    });
  }

  /**
   * Print PDF
   */
  printPDF(printWindow, jobData, resolve, reject) {
    // Wait a bit for PDF to fully render
    setTimeout(() => {
      const options = {
        silent: true,
        printBackground: jobData.printBackground !== false,
        deviceName: jobData.printerName || this.defaultPrinter || undefined,
        pageSize: jobData.pageSize || 'A4',
        margins: jobData.margins || {
          marginType: 'default'
        },
        copies: jobData.copies || 1
      };

      printWindow.webContents.print(options, (success, failureReason) => {
        // Clean up temporary PDF file if created
        if (jobData._tempPdfPath && fs.existsSync(jobData._tempPdfPath)) {
          try {
            fs.unlinkSync(jobData._tempPdfPath);
          } catch (error) {
            console.warn('Failed to delete temp PDF file:', error);
          }
        }
        
        printWindow.close();
        
        if (success) {
          resolve();
        } else {
          reject(new Error(failureReason || 'Print failed'));
        }
      });
    }, 1000); // Give PDF time to render

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!printWindow.isDestroyed()) {
        // Clean up temp file
        if (jobData._tempPdfPath && fs.existsSync(jobData._tempPdfPath)) {
          try {
            fs.unlinkSync(jobData._tempPdfPath);
          } catch (error) {
            console.warn('Failed to delete temp PDF file:', error);
          }
        }
        printWindow.close();
        reject(new Error('Print job timeout'));
      }
    }, 30000);
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
   * Get all jobs (including completed/failed)
   */
  getAllJobs() {
    return this.getJobQueue();
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId) {
    const jobIndex = this.jobQueue.findIndex(j => j.id === jobId);
    if (jobIndex !== -1) {
      const job = this.jobQueue.splice(jobIndex, 1)[0];
      job.status = 'cancelled';
      this.emit('job-updated', job);
      return true;
    }
    
    if (this.currentJob && this.currentJob.id === jobId) {
      this.currentJob.status = 'cancelled';
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
   * Clear completed jobs
   */
  clearCompletedJobs() {
    // In a real implementation, you'd maintain a separate history
    // For now, we just remove completed jobs from queue
    const initialLength = this.jobQueue.length;
    this.jobQueue = this.jobQueue.filter(job => job.status !== 'completed');
    return initialLength - this.jobQueue.length;
  }

  /**
   * Get spooler status
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.jobQueue.length,
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

