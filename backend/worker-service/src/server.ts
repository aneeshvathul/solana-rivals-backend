import express from 'express';

const app = express();
const port = 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.listen(port, () => {
  console.log(`Worker service started on port ${port}`);
}); 