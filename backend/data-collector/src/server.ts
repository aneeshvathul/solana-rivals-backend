import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const app = express();
const port = 3001; // Data collector service port
const RPC_URLS = process.env.RPC_URLS!.split(',');

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

// Allow all requests within Docker network but block external
app.use(cors({
    origin: true, // Allow all origins within Docker network
    methods: ['GET']
}));

// Interfaces
interface TokenBoost {
  url: string;
  chainId: string;
  tokenAddress: string;
  amount: number;
  totalAmount: number;
  icon: string;
  header: string;
  description: string;
  links: {
    type: string;
    label: string;
    url: string;
  }[];
}

interface PairInfo {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  pairCreatedAt: number;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: number;
  txns: { [key: string]: any };
  volume: {
    h24?: number;
    [key: string]: any;
  };
  priceChange: { [key: string]: any };
  liquidity: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  createdAt?: number;
  firstTxn?: number;
}

interface TokenInfoResponse {
  pairs: PairInfo[];
}

interface TokenData {
  token: TokenBoost;
  tokenInfo: TokenInfoResponse;
}

// Add new interfaces for whale tracking
interface WhaleTokenData {
  mint: string;
  frequency: number;
  totalVolume: number;
}

const WALLET_ADDRESSES = process.env.WHALE_ADDRESSES!.split(',');

// Add constants
const MIN_SOL_AMOUNT = 1.0;
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

const FILTERED_TOKENS = [
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"   // USDT
];

// Add interfaces if not already present
interface TokenChange {
  mint: string;
  change: number;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: {
    uiAmount: number | null;
  };
}

interface TokenFrequency {
  mint: string;
  frequency: number;
  totalVolume: number;
  netAmount: number;
}

// Add the interfaces and function at the top with other interfaces
interface Risk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: string;
}

interface RugcheckResponse {
  tokenProgram: string;
  tokenType: string;
  risks: Risk[];
  score: number;
}

// Database operations
async function clearTrendingTokenData() {
  try {
    const { error } = await supabase
      .from('trending_token_data')
      .delete()
      .neq('token_address', '');
    
    if (error) throw error;
  } catch (error) {
    throw error;
  }
}

async function insertTrendingTokenData(
  address: string,
  price: number | null,
  volume24h: number | null,
  liquidity: number | null,
  marketCap: number | null,
  lastHourBuys: number,
  lastHourSells: number,
  last5minBuys: number,
  last5minSells: number,
  description: string,
  m5PriceChange: number,
  h1PriceChange: number,
  h6PriceChange: number,
  h24PriceChange: number,
  ageInHours: number
) {
  try {
    const { error } = await supabase
      .from('trending_token_data')
      .upsert({
        token_address: address,
        price,
        volume_24_hr: volume24h,
        liquidity,
        market_cap: marketCap,
        last_hour_buys: lastHourBuys,
        last_hour_sells: lastHourSells,
        last_5min_buys: last5minBuys,
        last_5min_sells: last5minSells,
        description,
        '5min_price_change': m5PriceChange,
        '1hour_price_change': h1PriceChange,
        '6hour_price_change': h6PriceChange,
        '24hour_price_change': h24PriceChange,
        age_hours: ageInHours
      }, {
        onConflict: 'token_address'
      });

    if (error) throw error;
  } catch (error) {
    throw error;
  }
}

// Add database operation for whale tokens
async function clearWhaleTokenData() {
  try {
    const { error } = await supabase
      .from('whale_token_data')
      .delete()
      .neq('token_address', '');
    
    if (error) throw error;
  } catch (error) {
    throw error;
  }
}

async function insertWhaleTokenData(
  address: string,
  count: number,
  volume: number
) {
  try {
    const { error } = await supabase
      .from('whale_token_data')
      .upsert({
        token_address: address,
        count: count,
        volume: volume
      }, {
        onConflict: 'token_address'
      });

    if (error) throw error;
  } catch (error) {
    throw error;
  }
}

// Fetch Functions
async function fetchTrendingTokens(): Promise<TokenBoost[]> {
  const response = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
  if (!response.ok) throw new Error(`Failed to fetch trending tokens: ${response.statusText}`);
  const tokens = await response.json();
  return tokens.filter((token: TokenBoost) => token.chainId === 'solana');
}

async function fetchLatestTokens(): Promise<TokenBoost[]> {
  const response = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
  if (!response.ok) throw new Error(`Failed to fetch latest tokens: ${response.statusText}`);
  const tokens = await response.json();
  return tokens.filter((token: TokenBoost) => token.chainId === 'solana');
}

async function getTokenInfo(tokenAddress: string): Promise<TokenInfoResponse> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  if (!response.ok) throw new Error(`Failed to fetch token info: ${response.statusText}`);
  return await response.json();
}

async function getAllTrendingTokensData(): Promise<TokenData[]> {
  const [trendingTokens, latestTokens] = await Promise.all([
    fetchTrendingTokens(),
    fetchLatestTokens()
  ]);
  
  // Combine and remove duplicates based on tokenAddress
  const uniqueTokens = Array.from(
    new Map([...trendingTokens, ...latestTokens].map(token => [token.tokenAddress, token]))
    .values()
  );
  
  console.log(`Found ${trendingTokens.length} trending and ${latestTokens.length} latest tokens, ${uniqueTokens.length} unique`);

  const tokenDataList = await Promise.all(
    uniqueTokens.map(async (token) => {
      try {
        const tokenInfo = await getTokenInfo(token.tokenAddress);
        return { token, tokenInfo };
      } catch (err) {
        console.error(`Error fetching info for ${token.tokenAddress}:`, err);
        return null;
      }
    })
  );
  return tokenDataList.filter((item): item is TokenData => item !== null);
}

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'healthy' });
});

// Add this helper function for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Replace interval functions with continuous loops
async function startTrendingTokenCollection() {
  while (true) {
    try {
      const tokenData = await getAllTrendingTokensData();
      const newTokenBatch = [];

      for (const data of tokenData) {
        const { token, tokenInfo } = data;
        const bestPair = tokenInfo.pairs?.[0];
        
        if (bestPair) {
          try {
            await delay(3000); // Keep existing delay for rug checking
            const rugReport = await fetchRugcheckReport(token.tokenAddress);
            if (rugReport.score > 400) {
              console.log(`Skipping token ${token.tokenAddress} due to high rug score: ${rugReport.score}`);
              continue;
            }
          } catch (error) {
            console.error(`Error checking rug score for ${token.tokenAddress}, skipping:`, error);
            continue;
          }

          // Convert values with proper type handling
          const price = typeof bestPair.priceUsd === 'string' 
            ? parseFloat(bestPair.priceUsd) 
            : bestPair.priceUsd;
          
          const volume = typeof bestPair.volume?.h24 === 'string'
            ? parseFloat(bestPair.volume.h24)
            : bestPair.volume?.h24;
          
          const liquidity = typeof bestPair.liquidity?.usd === 'string'
            ? parseFloat(bestPair.liquidity.usd)
            : bestPair.liquidity?.usd;
          
          const marketCap = typeof bestPair.marketCap === 'string'
            ? parseFloat(bestPair.marketCap)
            : bestPair.marketCap;

          const txns = bestPair.txns || {};
          const h1 = txns.h1 || { buys: 0, sells: 0 };
          const m5 = txns.m5 || { buys: 0, sells: 0 };

          const priceChange = bestPair.priceChange || {};
          const m5PriceChange = priceChange.m5 || 0;
          const h1PriceChange = priceChange.h1 || 0;
          const h6PriceChange = priceChange.h6 || 0;
          const h24PriceChange = priceChange.h24 || 0;

          // Calculate age in hours
          const ageInHours = bestPair.pairCreatedAt 
            ? Math.floor((Date.now() - bestPair.pairCreatedAt) / (1000 * 60 * 60))
            : 0;

          // Store token data in memory instead of inserting immediately
          newTokenBatch.push({
            address: token.tokenAddress,
            price: price || null,
            volume24h: volume || null,
            liquidity: liquidity || null,
            marketCap: marketCap || null,
            lastHourBuys: h1.buys,
            lastHourSells: h1.sells,
            last5minBuys: m5.buys,
            last5minSells: m5.sells,
            description: token.description,
            m5PriceChange,
            h1PriceChange,
            h6PriceChange,
            h24PriceChange,
            ageInHours
          });
        }
      }

      if (newTokenBatch.length > 0) {
        await clearTrendingTokenData();
        for (const token of newTokenBatch) {
          await insertTrendingTokenData(
            token.address,
            token.price,
            token.volume24h,
            token.liquidity,
            token.marketCap,
            token.lastHourBuys,
            token.lastHourSells,
            token.last5minBuys,
            token.last5minSells,
            token.description,
            token.m5PriceChange,
            token.h1PriceChange,
            token.h6PriceChange,
            token.h24PriceChange,
            token.ageInHours
          );
        }
        console.log(`Updated database with ${newTokenBatch.length} new tokens`);
      }

    } catch (error) {
      console.error('Error in trending token collection:', error);
    }
  }
}

// Modify the TransactionFetcher class
class TransactionFetcher {
  private connection: Connection;
  private maxRetries = 3;
  private baseDelay = 2000;
  private tokenFrequencies: Map<string, TokenFrequency> = new Map();

  constructor() {
    this.connection = new Connection(RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)], {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
  }

  private async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError;
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        if (error.message.includes("429")) {
          const delay = this.baseDelay * Math.pow(2, i);
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  public async getRecentTransactions(wallet: string) {
    try {
      const signatures = await this.retry(() =>
        this.connection.getSignaturesForAddress(
          new PublicKey(wallet),
          { limit: 10 }
        )
      );

      if (signatures.length === 0) {
        return;
      }

      const BATCH_SIZE = 3;
      for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
        const batch = signatures.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (sig) => {
          try {
            const txData = await this.retry(() =>
              this.connection.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
              })
            );

            if (!txData || !txData.meta) return;

            this.displayTransaction(txData, sig);
          } catch (error) {
          }
        }));

        if (i + BATCH_SIZE < signatures.length) {
          await this.sleep(2000);
        }
      }

    } catch (error) {
    }
  }

  public async analyzeMultipleWallets(wallets: string[]) {
    for (const wallet of wallets) {
      await this.getRecentTransactions(wallet);
      await this.sleep(2000);
    }
  }

  private displayTransaction(txData: any, sig: any) {
    const timestamp = new Date(sig.blockTime! * 1000);
    
    const solTransfers = txData.transaction.message.instructions
      .filter((ix: any) => {
        return "parsed" in ix &&
               ix.parsed.type === "transfer" &&
               (ix.parsed.info.lamports / LAMPORTS_PER_SOL) >= MIN_SOL_AMOUNT;
      });

    const tokenChanges = txData.meta.postTokenBalances?.map((post: TokenBalance) => {
      const pre = txData.meta!.preTokenBalances!.find(
        (pre: TokenBalance) => pre.accountIndex === post.accountIndex
      );
      return {
        mint: post.mint,
        change: (post.uiTokenAmount.uiAmount || 0) -
               (pre?.uiTokenAmount.uiAmount || 0)
      };
    })
    .filter((change: TokenChange) =>
      !FILTERED_TOKENS.includes(change.mint) &&
      change.change > 0
    ) || [];

    tokenChanges.forEach((change: TokenChange) => {
      const existing = this.tokenFrequencies.get(change.mint) || {
        mint: change.mint,
        frequency: 0,
        totalVolume: 0,
        netAmount: 0
      };
      
      existing.frequency += 1;
      existing.totalVolume += change.change;
      existing.netAmount += change.change;
      this.tokenFrequencies.set(change.mint, existing);
    });
  }

  public getTokenFrequencies(): Map<string, TokenFrequency> {
    return this.tokenFrequencies;
  }
}

// Start server
app.listen(port, () => {
  startTrendingTokenCollection();
});

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
});

process.on('unhandledRejection', (error) => {
});

// Modify fetchRugcheckReport to use authentication
async function fetchRugcheckReport(tokenAddress: string, retries = 3): Promise<RugcheckResponse> {
  const baseUrl = 'https://api.rugcheck.xyz/v1';
  const url = `${baseUrl}/tokens/${tokenAddress}/report/summary`;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data as RugcheckResponse;
    } catch (error) {
      if (i === retries - 1) {
        console.error('Error fetching rugcheck report:', error);
        throw error;
      }
      // Wait before retrying (shorter backoff)
      await delay((i + 1) * 500); // 500ms, 1000ms, 1500ms instead of 2000ms, 4000ms, 6000ms
    }
  }
  throw new Error('Max retries reached');
}

// Add a new endpoint to get trending tokens
app.get('/trending-tokens', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trending_token_data')
      .select(`
        token_address,
        price,
        volume_24_hr,
        liquidity,
        market_cap,
        last_hour_buys,
        last_hour_sells,
        last_5min_buys,
        last_5min_sells,
        description,
        "5min_price_change",
        "1hour_price_change",
        "6hour_price_change",
        "24hour_price_change",
        age_hours
      `);
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching trending tokens:', error);
    res.status(500).json({ error: 'Failed to fetch trending tokens' });
  }
});