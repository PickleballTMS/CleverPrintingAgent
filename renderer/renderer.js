let currentFilter = 'all';
let jobs = [];

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    await loadStatus();
    await loadJobs();
    await loadConfig();
    
    setupEventListeners();
    setupJobUpdateListener();
    
    // Refresh status every 2 seconds
    setInterval(loadStatus, 2000);
    setInterval(loadJobs, 2000);
});

async function loadStatus() {
    try {
        const status = await window.electronAPI.getStatus();
        updateStatusDisplay(status);
    } catch (error) {
        console.error('Error loading status:', error);
    }
}

async function loadJobs() {
    try {
        jobs = await window.electronAPI.getJobs();
        renderJobs();
    } catch (error) {
        console.error('Error loading jobs:', error);
    }
}

async function loadConfig() {
    try {
        const config = await window.electronAPI.getConfig();
        document.getElementById('api-port').textContent = config.apiPort || 3001;
        document.getElementById('api-port-display').textContent = config.apiPort || 3001;
        
        // Load server URL
        const serverUrl = config.serverBaseUrl || '';
        document.getElementById('server-url-input').value = serverUrl;
        document.getElementById('server-url-display').textContent = serverUrl || 'Not configured';
        
        // Load API key (show masked indicator if set)
        const apiKey = config.apiKey || '';
        const apiKeyInput = document.getElementById('api-key-input');
        apiKeyInput.value = apiKey;
        if (apiKey) {
            // Add a visual indicator that API key is set
            apiKeyInput.placeholder = 'API key is set (click to change)';
            apiKeyInput.style.borderColor = '#4ade80';
        } else {
            apiKeyInput.placeholder = 'Enter API key (optional)';
            apiKeyInput.style.borderColor = '#dee2e6';
        }
        
        // Update connection status
        if (serverUrl) {
            await checkServerConnection();
        } else {
            document.getElementById('server-connection-status').textContent = 'Not configured';
            document.getElementById('server-connection-status').style.color = '#6c757d';
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

function updateStatusDisplay(status) {
    document.getElementById('queue-length').textContent = status.queueLength || 0;
    document.getElementById('processing-status').textContent = status.isProcessing ? 'Yes' : 'No';
    document.getElementById('default-printer').textContent = status.defaultPrinter || 'Not set';
    
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    if (status.isProcessing) {
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Processing';
    } else if (status.queueLength > 0) {
        statusDot.className = 'status-dot';
        statusText.textContent = 'Ready';
    } else {
        statusDot.className = 'status-dot active';
        statusText.textContent = 'Idle';
    }
}

function renderJobs() {
    const jobsList = document.getElementById('jobs-list');
    
    const filteredJobs = jobs.filter(job => {
        if (currentFilter === 'all') return true;
        // "processing" filter should include both "processing" and "printing" statuses
        if (currentFilter === 'processing') {
            return job.status === 'processing' || job.status === 'printing';
        }
        // "completed" filter should show completed jobs
        if (currentFilter === 'completed') {
            return job.status === 'completed';
        }
        return job.status === currentFilter;
    });
    
    if (filteredJobs.length === 0) {
        jobsList.innerHTML = '<div class="empty-state"><p>No print jobs ' + 
            (currentFilter !== 'all' ? `with status "${currentFilter}"` : '') + 
            '</p></div>';
        return;
    }
    
    jobsList.innerHTML = filteredJobs.map(job => createJobCard(job)).join('');
    
    // Attach event listeners to action buttons
    filteredJobs.forEach(job => {
        const cancelBtn = document.getElementById(`cancel-${job.id}`);
        const retryBtn = document.getElementById(`retry-${job.id}`);
        
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => cancelJob(job.id));
        }
        if (retryBtn) {
            retryBtn.addEventListener('click', () => retryJob(job.id));
        }
    });
}

function createJobCard(job) {
    const timestamp = new Date(job.timestamp).toLocaleString();
    const priority = job.priority || 'normal';
    
    let actionsHTML = '';
    if (job.status === 'queued' || job.status === 'processing') {
        actionsHTML = `<button class="job-action-btn danger" id="cancel-${job.id}">Cancel</button>`;
    } else if (job.status === 'failed') {
        actionsHTML = `<button class="job-action-btn" id="retry-${job.id}">Retry</button>`;
    }
    
    const errorHTML = job.error ? 
        `<div class="job-error">Error: ${escapeHtml(job.error)}</div>` : '';
    
    return `
        <div class="job-card">
            <div class="job-header">
                <span class="job-id">${escapeHtml(job.id)}</span>
                <span class="job-status ${job.status}">${job.status}</span>
            </div>
            <div class="job-details">
                <div class="job-detail-item">
                    <label>Timestamp</label>
                    <span>${timestamp}</span>
                </div>
                <div class="job-detail-item">
                    <label>Priority</label>
                    <span>${priority}</span>
                </div>
                <div class="job-detail-item">
                    <label>Retries</label>
                    <span>${job.retryCount || 0}</span>
                </div>
            </div>
            ${errorHTML}
            ${actionsHTML ? `<div class="job-actions">${actionsHTML}</div>` : ''}
        </div>
    `;
}

function setupEventListeners() {
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentFilter = e.target.dataset.filter;
            renderJobs();
        });
    });
    
    // Action buttons
    document.getElementById('select-printer-btn').addEventListener('click', selectPrinter);
    document.getElementById('refresh-btn').addEventListener('click', () => {
        loadStatus();
        loadJobs();
    });
    document.getElementById('clear-completed-btn').addEventListener('click', clearCompleted);
    
    // Server URL configuration
    document.getElementById('save-server-url-btn').addEventListener('click', saveServerUrl);
    document.getElementById('test-server-btn').addEventListener('click', checkServerConnection);
}

function setupJobUpdateListener() {
    window.electronAPI.onJobUpdate((data) => {
        loadStatus();
        loadJobs();
    });
}

async function selectPrinter() {
    try {
        const printer = await window.electronAPI.selectPrinter();
        if (printer) {
            loadStatus();
            alert(`Default printer set to: ${printer.name}`);
        }
    } catch (error) {
        console.error('Error selecting printer:', error);
        alert('Failed to select printer');
    }
}

async function cancelJob(jobId) {
    try {
        const success = await window.electronAPI.cancelJob(jobId);
        if (success) {
            loadJobs();
            loadStatus();
        } else {
            alert('Failed to cancel job');
        }
    } catch (error) {
        console.error('Error cancelling job:', error);
        alert('Failed to cancel job');
    }
}

async function retryJob(jobId) {
    try {
        const success = await window.electronAPI.retryJob(jobId);
        if (success) {
            loadJobs();
            loadStatus();
        } else {
            alert('Failed to retry job');
        }
    } catch (error) {
        console.error('Error retrying job:', error);
        alert('Failed to retry job');
    }
}

async function clearCompleted() {
    try {
        const count = await window.electronAPI.clearCompleted();
        if (count > 0) {
            loadJobs();
            alert(`Cleared ${count} completed job(s)`);
        } else {
            alert('No completed jobs to clear');
        }
    } catch (error) {
        console.error('Error clearing completed jobs:', error);
        alert('Failed to clear completed jobs');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function saveServerUrl() {
    try {
        const serverUrl = document.getElementById('server-url-input').value.trim();
        const apiKey = document.getElementById('api-key-input').value.trim();
        const apiKeyInput = document.getElementById('api-key-input');
        
        await window.electronAPI.setConfig('serverBaseUrl', serverUrl);
        await window.electronAPI.setConfig('apiKey', apiKey);
        
        document.getElementById('server-url-display').textContent = serverUrl || 'Not configured';
        
        // Update API key input placeholder and styling
        if (apiKey) {
            apiKeyInput.placeholder = 'API key is set (click to change)';
            apiKeyInput.style.borderColor = '#4ade80';
        } else {
            apiKeyInput.placeholder = 'Enter API key (optional)';
            apiKeyInput.style.borderColor = '#dee2e6';
        }
        
        // Notify main process to restart polling
        await window.electronAPI.updateServerConfig();
        
        if (serverUrl) {
            await checkServerConnection();
            alert('Server configuration saved successfully!');
        } else {
            document.getElementById('server-connection-status').textContent = 'Not configured';
            document.getElementById('server-connection-status').style.color = '#6c757d';
            alert('Server URL cleared. Polling stopped.');
        }
    } catch (error) {
        console.error('Error saving server configuration:', error);
        alert('Failed to save server configuration: ' + error.message);
    }
}

async function checkServerConnection() {
    try {
        const statusEl = document.getElementById('server-connection-status');
        statusEl.textContent = 'Testing...';
        statusEl.style.color = '#6c757d';
        
        const result = await window.electronAPI.testServerConnection();
        
        if (result.success) {
            statusEl.textContent = 'Connected';
            statusEl.style.color = '#0f5132';
        } else {
            statusEl.textContent = `Failed: ${result.error || 'Unknown error'}`;
            statusEl.style.color = '#842029';
            // Log full error details to console for debugging
            console.error('Connection test failed:', result);
        }
    } catch (error) {
        console.error('Error testing server connection:', error);
        const statusEl = document.getElementById('server-connection-status');
        statusEl.textContent = 'Error: ' + (error.message || 'Failed to test connection');
        statusEl.style.color = '#842029';
    }
}

