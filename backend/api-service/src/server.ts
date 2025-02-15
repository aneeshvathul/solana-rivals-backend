// api-service/src/server.ts
import express from 'express';

const app = express();
const port = 3000;

// Basic middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'healthy' });
});

// // Start the interval printing
// const startInterval = () => {
//   setInterval(() => {
//     console.log('Server is running - checking in every 5 seconds!');
//   }, 5000);
// };

// Start server
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  // startInterval();
});