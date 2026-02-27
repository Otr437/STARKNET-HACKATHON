class StarCladApp {
    constructor() {
        this.baseUrl = '';
        this.apiKey = '';
        this.connected = false;
    }

    async apiCall(endpoint, method = 'GET', data = null) {
        const url = this.baseUrl + endpoint;
        const headers = {
            'Content-Type': 'application/json'
        };
        
        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }

        const options = {
            method,
            headers,
            mode: 'cors'
        };

        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, options);
            const result = await response.json();
            
            if (!response.ok) {
                throw new Error(result.error || 'Request failed');
            }
            
            return result;
        } catch (error) {
            this.showAlert(error.message, 'error');
            throw error;
        }
    }

    async testConnection() {
        this.baseUrl = document.getElementById('backendUrl').value;
        this.apiKey = document.getElementById('apiKey').value;

        try {
            await this.apiCall('/health');
            this.connected = true;
            document.getElementById('statusDot').classList.add('connected');
            document.getElementById('statusText').textContent = 'Connected';
            this.showAlert('Connected successfully!', 'success');
        } catch (error) {
            this.connected = false;
            document.getElementById('statusDot').classList.remove('connected');
            document.getElementById('statusText').textContent = 'Disconnected';
            this.showAlert('Connection failed: ' + error.message, 'error');
        }
    }

    async generateNote() {
        const amount = document.getElementById('noteAmount').value;
        const recipient = document.getElementById('noteRecipient').value;

        if (!amount || !recipient) {
            return this.showAlert('Please fill all fields', 'error');
        }

        try {
            const result = await this.apiCall('/api/notes/generate', 'POST', {
                amount,
                recipient
            });

            document.getElementById('noteResult').textContent = JSON.stringify(result, null, 2);
            this.showAlert('Note generated successfully!', 'success');
        } catch (error) {
            console.error(error);
        }
    }

    async initiateSwap() {
        const initiator = document.getElementById('swapInitiator').value;
        const recipient = document.getElementById('swapRecipient').value;
        const amount = document.getElementById('swapAmount').value;
        const timelockDuration = document.getElementById('swapTimelock').value;

        if (!initiator || !recipient || !amount) {
            return this.showAlert('Please fill all fields', 'error');
        }

        try {
            const result = await this.apiCall('/api/swaps/initiate', 'POST', {
                initiator,
                recipient,
                amount,
                timelockDuration: parseInt(timelockDuration)
            });

            document.getElementById('swapResult').textContent = JSON.stringify(result, null, 2);
            this.showAlert('Swap initiated! Save the HTLC secret securely.', 'success');
        } catch (error) {
            console.error(error);
        }
    }

    async generateSPV() {
        const txid = document.getElementById('spvTxid').value;

        if (!txid) {
            return this.showAlert('Please enter transaction ID', 'error');
        }

        try {
            const result = await this.apiCall('/api/btc/spv-proof', 'POST', { txid });
            document.getElementById('spvResult').textContent = JSON.stringify(result, null, 2);
            this.showAlert('SPV proof generated!', 'success');
        } catch (error) {
            console.error(error);
        }
    }

    async loadStats() {
        try {
            const result = await this.apiCall('/api/swaps/stats');
            document.getElementById('statsResult').textContent = JSON.stringify(result, null, 2);
        } catch (error) {
            console.error(error);
        }
    }

    switchTab(tabName) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        
        event.target.classList.add('active');
        document.getElementById(tabName + '-tab').classList.add('active');
    }

    showAlert(message, type) {
        const alertsDiv = document.getElementById('alerts');
        const alert = document.createElement('div');
        alert.className = `alert ${type}`;
        alert.textContent = message;
        alert.style.display = 'block';
        
        alertsDiv.appendChild(alert);
        
        setTimeout(() => {
            alert.remove();
        }, 5000);
    }
}

const app = new StarCladApp();
