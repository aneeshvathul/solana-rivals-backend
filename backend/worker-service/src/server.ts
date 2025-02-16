import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { AgentManager } from './AgentManager';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '../.env' });
// Validate required environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    throw new Error('Required environment variables SUPABASE_URL and SUPABASE_KEY must be set');
}

const app = express();
const agentManager = new AgentManager();

// Initialize Supabase client with environment variables
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);

// Basic middleware
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'healthy' });
});

app.post('/create-agent', async (req, res) => {
  const { userId } = req.body;
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ 
      message: 'Unauthorized - no JWT token provided' 
    });
  }

  // Extract JWT token
  const token = authHeader.split('Bearer ')[1];
  
  try {
    // Verify the JWT token directly with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error) {
      return res.status(401).json({ 
        message: 'Unauthorized - invalid token',
        error: error.message
      });
    }

    if (!user || user.id !== userId) {
      return res.status(401).json({ 
        message: 'Unauthorized - user ID mismatch' 
      });
    }
    

    await agentManager.createAgent(userId);
    
    res.json({ 
      message: 'Agent created successfully',
      agentId: userId // or whatever ID your agentManager returns
    });
    
  } catch (error) {
    console.error('Error in create-agent route:', error);
    res.status(500).json({ 
      message: 'Internal server error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
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
const port = 3002; // Worker service port
app.listen(port, () => {
  console.log(`Agent server running on port ${port}`);
});