const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * ServerClient - Handles communication with remote print server
 * Polls the server for new print jobs and submits job status updates
 */
class ServerClient {
  constructor(configManager) {
    this.configManager = configManager;
    this.pollInterval = null;
    this.isPolling = false;
    this.pollIntervalMs = 5000; // Poll every 5 seconds
    this.lastPollTime = null;
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = 45000; // Heartbeat every 45 seconds
    this.currentStatus = 'online';
    this.hostname = null;
    this.agentVersion = null;
    this.initializeAgentInfo();
  }

  /**
   * Initialize agent information (hostname and version)
   */
  initializeAgentInfo() {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    
    this.hostname = os.hostname();
    
    // Try to get version from Electron app, fallback to package.json
    try {
      const { app } = require('electron');
      this.agentVersion = app.getVersion() || this.getVersionFromPackageJson();
    } catch (e) {
      // Electron app not available yet, use package.json
      this.agentVersion = this.getVersionFromPackageJson();
    }
  }

  /**
   * Get version from package.json
   */
  getVersionFromPackageJson() {
    try {
      const path = require('path');
      const fs = require('fs');
      const packageJsonPath = path.join(__dirname, '../../package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      return packageJson.version || '1.0.0';
    } catch (e) {
      return '1.0.0';
    }
  }

  /**
   * Get the server base URL from config
   */
  getServerBaseUrl() {
    return this.configManager.get('serverBaseUrl', '');
  }

  /**
   * Get the API key from config
   */
  getApiKey() {
    return this.configManager.get('apiKey', '');
  }

  /**
   * Check if server URL is configured
   */
  isConfigured() {
    const url = this.getServerBaseUrl();
    return url && url.trim().length > 0;
  }

  /**
   * Make HTTP request to server
   */
  makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
      const serverUrl = this.getServerBaseUrl();
      if (!serverUrl) {
        return reject(new Error('Server base URL not configured'));
      }

      try {
        const url = new URL(path, serverUrl);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const apiKey = this.getApiKey();
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'CleverPrintingAgent/1.0.0'
        };

        // Add API key to headers if configured
        if (apiKey && apiKey.trim().length > 0) {
          const trimmedKey = apiKey.trim();
          // Support both Authorization Bearer token and X-API-Key header formats
          if (trimmedKey.toLowerCase().startsWith('bearer ')) {
            // If it's already a Bearer token, use Authorization header only
            headers['Authorization'] = trimmedKey;
          } else {
            // Otherwise, use both X-API-Key (common) and Authorization Bearer (for compatibility)
            headers['X-API-Key'] = trimmedKey;
            headers['Authorization'] = `Bearer ${trimmedKey}`;
          }
        }

        const options = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: method,
          headers: headers
        };

        const req = client.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = body ? JSON.parse(body) : {};
              resolve({ 
                status: res.statusCode, 
                data: parsed,
                headers: res.headers
              });
            } catch (e) {
              resolve({ 
                status: res.statusCode, 
                data: body,
                headers: res.headers
              });
            }
          });
        });

        req.on('error', (error) => {
          reject(error);
        });

        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });

        if (data) {
          req.write(JSON.stringify(data));
        }

        req.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Poll server for new print jobs
   */
  async pollForJobs() {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const response = await this.makeRequest('GET', '/api/command-center/printing/pending-jobs?limit=10');
      
      if (response.status === 200 && response.data.jobs) {
        this.lastPollTime = new Date();
        return response.data.jobs || [];
      } else if (response.status === 404) {
        // Endpoint might not exist, return empty array
        return [];
      } else {
        console.error(`Server returned status ${response.status}:`, response.data);
        return [];
      }
    } catch (error) {
      console.error('Error polling server for jobs:', error.message || error);
      return [];
    }
  }

  /**
   * Update job status on server
   * @param {string} jobId - Server job ID
   * @param {string} status - "printed" or "failed"
   * @param {string} errorMessage - Optional error message when status is "failed"
   */
  async updateJobStatus(jobId, status, errorMessage = null) {
    if (!this.isConfigured()) {
      return false;
    }

    if (!jobId) {
      console.error('Cannot update job status: jobId is required');
      return false;
    }

    // Map local status to server status
    let serverStatus = status;
    if (status === 'completed') {
      serverStatus = 'printed';
    } else if (status !== 'printed' && status !== 'failed') {
      console.warn(`Unknown status "${status}", using "failed"`);
      serverStatus = 'failed';
    }

    try {
      const body = {
        status: serverStatus
      };

      // Only include errorMessage if status is "failed"
      if (serverStatus === 'failed' && errorMessage) {
        body.errorMessage = errorMessage;
      }

      console.log(`Updating job ${jobId} status to ${serverStatus}`, body);

      const response = await this.makeRequest('POST', `/api/command-center/printing/jobs/${jobId}/status`, body);

      if (response.status === 200 || response.status === 201 || response.status === 204) {
        console.log(`Successfully updated job ${jobId} status to ${serverStatus}`);
        return true;
      } else {
        console.error(`Failed to update job ${jobId} status: HTTP ${response.status}`, response.data);
        return false;
      }
    } catch (error) {
      console.error(`Error updating job ${jobId} status:`, error.message);
      return false;
    }
  }

  /**
   * Send heartbeat to server
   */
  async sendHeartbeat(status = null, errorMessage = null) {
    if (!this.isConfigured()) {
      console.log('Heartbeat skipped: Server URL not configured');
      return false;
    }

    try {
      const heartbeatStatus = status || this.currentStatus;
      const body = {
        hostname: this.hostname,
        agentVersion: this.agentVersion,
        status: heartbeatStatus
      };

      // Only include errorMessage if status is 'error'
      if (heartbeatStatus === 'error' && errorMessage) {
        body.errorMessage = errorMessage;
      }

      console.log(`Sending heartbeat to ${this.getServerBaseUrl()}/api/command-center/printing/heartbeat`);
      console.log(`Heartbeat payload:`, JSON.stringify(body, null, 2));
      const response = await this.makeRequest('POST', '/api/command-center/printing/heartbeat', body);

      if (response.status === 200 || response.status === 201 || response.status === 204) {
        this.currentStatus = heartbeatStatus;
        console.log(`Heartbeat sent successfully: ${heartbeatStatus}`);
        return true;
      } else {
        console.error(`Heartbeat failed with status ${response.status}:`, response.data);
        return false;
      }
    } catch (error) {
      console.error('Error sending heartbeat:', error.message);
      console.error('Heartbeat error details:', error);
      return false;
    }
  }

  /**
   * Start sending periodic heartbeats
   */
  startHeartbeat() {
    // Stop any existing heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (!this.isConfigured()) {
      console.log('Heartbeat not started: Server URL not configured');
      return;
    }

    console.log(`Starting heartbeat mechanism (every ${this.heartbeatIntervalMs}ms)`);
    console.log(`  - Server URL: ${this.getServerBaseUrl()}`);
    console.log(`  - Hostname: ${this.hostname}`);
    console.log(`  - Agent Version: ${this.agentVersion}`);

    // Send initial heartbeat on startup
    this.sendHeartbeat('online').catch(err => {
      console.error('Failed to send initial heartbeat:', err.message);
    });

    // Then send heartbeat at intervals
    this.heartbeatInterval = setInterval(() => {
      console.log(`Sending periodic heartbeat (interval: ${this.heartbeatIntervalMs}ms)`);
      this.sendHeartbeat().catch(err => {
        console.error('Failed to send periodic heartbeat:', err.message);
      });
    }, this.heartbeatIntervalMs);

    console.log(`Heartbeat mechanism started successfully`);
  }

  /**
   * Stop sending heartbeats
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Send offline heartbeat before stopping
    if (this.isConfigured()) {
      this.sendHeartbeat('offline').catch(err => {
        console.error('Failed to send offline heartbeat:', err.message);
      });
    }

    console.log('Stopped heartbeat mechanism');
  }

  /**
   * Register agent with server (deprecated - use heartbeat instead)
   */
  async registerAgent() {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      const { app } = require('electron');
      const os = require('os');
      
      const response = await this.makeRequest('POST', '/api/agents/register', {
        agentId: `agent-${os.hostname()}-${Date.now()}`,
        hostname: os.hostname(),
        platform: process.platform,
        version: app.getVersion(),
        timestamp: new Date().toISOString()
      });

      return response.status === 200 || response.status === 201;
    } catch (error) {
      console.error('Error registering agent:', error.message);
      return false;
    }
  }

  /**
   * Start polling server for print jobs
   */
  startPolling(callback) {
    if (this.isPolling) {
      return;
    }

    if (!this.isConfigured()) {
      console.log('Server URL not configured, skipping polling');
      return;
    }

    this.isPolling = true;
    console.log(`Starting to poll server at ${this.getServerBaseUrl()} every ${this.pollIntervalMs}ms`);

    // Poll immediately
    this.pollForJobs().then(jobs => {
      if (jobs && jobs.length > 0 && callback) {
        callback(jobs);
      }
    });

    // Then poll at intervals
    this.pollInterval = setInterval(async () => {
      try {
        const jobs = await this.pollForJobs();
        if (jobs && jobs.length > 0 && callback) {
          callback(jobs);
        }
      } catch (error) {
        console.error('Error in polling interval:', error.message);
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop polling server
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isPolling = false;
    console.log('Stopped polling server');
  }

  /**
   * Stop all server communication (polling and heartbeat)
   */
  stop() {
    this.stopPolling();
    this.stopHeartbeat();
  }

  /**
   * Test server connection
   */
  async testConnection() {
    if (!this.isConfigured()) {
      return { success: false, error: 'Server URL not configured' };
    }

    try {
      const response = await this.makeRequest('GET', '/api/print-jobs/health');
      return {
        success: response.status === 200,
        status: response.status,
        data: response.data
      };
    } catch (error) {
      // Provide better error messages for common network errors
      let errorMessage = 'Unknown error';
      
      if (error.message) {
        errorMessage = error.message;
      } else if (error.code) {
        // Handle common network error codes
        if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused. Check if the server is running and the URL is correct.';
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Server hostname not found. Check the server URL.';
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timeout. The server may be unreachable.';
        } else {
          errorMessage = `Network error: ${error.code}`;
        }
      } else if (typeof error === 'string') {
        errorMessage = error;
      }
      
      return {
        success: false,
        error: errorMessage
      };
    }
  }
}

module.exports = ServerClient;

