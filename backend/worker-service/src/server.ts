import express from 'express';
import cors from 'cors';
import { AgentManager } from './AgentManager';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '../.env' });

const app = express();
const agentManager = new AgentManager();

// Basic middleware
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/create-agent', (req, res) => {
  const { userId, agentSettings } = req.body; 
  agentManager.createAgent(userId, agentSettings);
  res.json({ message: 'Agent created and running' });
});

app.post('/update-agent', (req, res) => {
  const { userId, newSettings } = req.body;
  agentManager.updateAgentSettings(userId, newSettings);
  res.json({ message: 'Agent settings updated' });
});

app.post('/stop-agent', (req, res) => {
  const { userId } = req.body;
  agentManager.stopAgent(userId);
  res.json({ message: 'Agent stopped' });
});

// // Start the interval printing
// const startInterval = () => {
//   setInterval(() => {
//     console.log('Server is running - checking in every 5 seconds!');
//   }, 5000);
// };

// Start server
const port = 3002; // Changed to match api-service port in docker setup
app.listen(port, () => {
  console.log(`Agent server running on port ${port}`);
  agentManager.createAgent("1", "nothing_yet");// startInterval();

});