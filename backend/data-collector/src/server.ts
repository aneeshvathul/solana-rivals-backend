import express from 'express';
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

const WALLET_ADDRESSES = [
  "BXrSExYkk2BUd8zP9d7oWTTCTxX3zksahRmVZiaqJeto",
  "9gCNRVGmWPEcUmthsd676FR3nTRwv8QkcNdphVHso48Z",
  "6jvYtr9G5WQnKs3cFsFtKmEfkbEnUXFhBKsmZad26QPV",
  "CWaTfG6yzJPQRY5P53nQYHdHLjCJGxpC7EWo5wzGqs3n",
  "5ubfFGJ2z9YDx31msm1SiCUiJpQbeKAFZ4e1bbaUmTEz",
  "CfkpaaKL72sbTt6RsfeGj1ig1bQqHHbboHxyBmJQLqMS",
  "3LkGTjNsF2zWc2ddBPHYyEJJZKqbdHJDgfjztxnjwL5R",
  "DQ97nu7t7fbhAtZUyam8EzNsxUzw5bgEE5seBfevPwRK",
  "kkeMuhtCkfer15rAyxRMoAdHe2kv4ujWSjNcpm38iQh",
  "2EkRxR6GqMcFFpBrcPrt15ashBAJxAdryjk7nDntWPSC"
];

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
  description: string
) {
  try {
    const { error } = await supabase
      .from('trending_token_data')
      .upsert({
        token_address: address,
        price: price,
        volume_24_hr: volume24h,
        liquidity: liquidity,
        market_cap: marketCap,
        last_hour_buys: lastHourBuys,
        last_hour_sells: lastHourSells,
        last_5min_buys: last5minBuys,
        last_5min_sells: last5minSells,
        description: description
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

async function getTokenInfo(tokenAddress: string): Promise<TokenInfoResponse> {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
  if (!response.ok) throw new Error(`Failed to fetch token info: ${response.statusText}`);
  return await response.json();
}

async function getAllTrendingTokensData(): Promise<TokenData[]> {
  const trendingTokens = await fetchTrendingTokens();
  console.log(`Found ${trendingTokens.length} trending Solana tokens`);

  const tokenDataList = await Promise.all(
    trendingTokens.map(async (token) => {
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

// Basic middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'healthy' });
});

// Modified interval function
const startTrendingTokenInterval = () => {
  setInterval(async () => {
    try {
      const tokenData = await getAllTrendingTokensData();
      
      await clearTrendingTokenData();

      for (const data of tokenData) {
        const { token, tokenInfo } = data;
        const bestPair = tokenInfo.pairs?.[0];
        
        if (bestPair) {
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

          await insertTrendingTokenData(
            token.tokenAddress,
            price || null,
            volume || null,
            liquidity || null,
            marketCap || null,
            h1.buys,
            h1.sells,
            m5.buys,
            m5.sells,
            token.description
          );
        }
      }

    } catch (error) {
    }
  }, 120000);
};

// Add the whale token interval function
const startWhaleTokenInterval = () => {
  setInterval(async () => {
    try {
      const fetcher = new TransactionFetcher();
      await fetcher.analyzeMultipleWallets(WALLET_ADDRESSES);
      
      const tokenData = fetcher.getTokenFrequencies();
      
      await clearWhaleTokenData();

      for (const [mint, data] of tokenData) {
        await insertWhaleTokenData(
          mint,
          data.frequency,
          data.totalVolume
        );
      }

    } catch (error) {
    }
  }, 180000);
};

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
  startTrendingTokenInterval();
  startWhaleTokenInterval();
});

// Add error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
});

process.on('unhandledRejection', (error) => {
});