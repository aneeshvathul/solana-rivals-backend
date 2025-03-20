import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { makeTrade, getPrice, getTokenBalance, getTokenDecimals } from "./AgentTools";
import dotenv from 'dotenv';
import { createClient, PostgrestError } from '@supabase/supabase-js';
import { Connection, Keypair } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
import * as crypto from 'crypto';

dotenv.config({ path: '../.env' });

const algorithm = 'aes-256-cbc'; // Encryption algorithm
const key = Buffer.from(process.env.CRYPT_KEY!, 'hex');
const iv = Buffer.from(process.env.CRYPT_IV!, 'hex');


const NUM_SLOTS: number = 3;
const INPUT_ADDRESS: string = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL: number = 1e9;
const BUY_AMOUNT_LAMPORTS: number = 2000000; // Already in lamports
const SLIPPAGE: number = 200;
const RPC_URLS = process.env.RPC_URLS!.split(',');


// Add interface for slot data
interface SlotData {
    slot_id: string;
    buy_price: number;
    buy_amount: number;
    buy_address: string;
    state: boolean;
}

// Add interface for agent preferences
interface AgentPreferences {
    liquidity: { min: number; max: number; importance: number };
    age: { min: number; importance: number };
    volume: { min: number; max: number; importance: number };
    marketCap: { min: number; importance: number };
    sentiment: { importance: number };
    whale: { importance: number };
    sellFloor: number;
    sellCeiling: number;
}

// Add these interfaces at the top of the file with other interfaces
interface TokenData {
    token_id?: string;
    token_address: string;
    price: number | null;
    volume_24_hr: number | null;
    liquidity: number | null;
    market_cap: number | null;
    last_hour_buys: number;
    last_hour_sells: number;
    last_5min_buys: number;
    last_5min_sells: number;
    description: string;
    "5min_price_change": number;
    "1hour_price_change": number;
    "6hour_price_change": number;
    "24hour_price_change": number;
    age_hours: number;
}

interface WhaleTokenData {
    token_address: string;
    count: number;
    volume: number;
}

const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_KEY || ''
);

  // Custom memory saver class that limits cached messages
  // class LimitedMemorySaver extends MemorySaver {
  //   private maxMessages: number;
  //   private messages: any[] = [];

  //   constructor(maxMessages: number = 10) {
  //     super();
  //     this.maxMessages = maxMessages;
  //   }

  //   async saveCheckpoint(checkpoint: any) {
  //     this.messages.push(checkpoint);
      
  //     // Remove oldest messages if we exceed the limit
  //     if (this.messages.length > this.maxMessages) {
  //       this.messages = this.messages.slice(-this.maxMessages);
  //     }
  //   }

  //   async loadCheckpoint() {
  //     return this.messages;
  //   }

  //   async clear() {
  //     this.messages = [];
  //   }
  // }
  function encrypt(text: string): string {
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

function validateEnvironment(): void {
const missingVars: string[] = [];

const requiredVars = ["OPENAI_API_KEY", "RPC_URLS"];
requiredVars.forEach(varName => {
    if (!process.env[varName]) {
    missingVars.push(varName);
    }
});

if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set");
    missingVars.forEach(varName => {
    console.error(`${varName}=your_${varName.toLowerCase()}_here`);
    });
    process.exit(1);
}
}

type Agent = {
    id: string;
    userId: string;
    intervalId: NodeJS.Timeout | null;
    bot: any;
};
  
export class AgentManager {
    private agents: Map<string, Agent> = new Map();
  
    async createAgent(userId: string) {
        if (this.agents.has(userId)) {
            console.log(`Agent for user ${userId} already exists.`);
            return;
        }
    
        validateEnvironment();

        try {
            const llm = new ChatOpenAI({
                modelName: "gpt-4o-mini",
                temperature: 0.7,
            });
            
            const agentBot = llm;

            const agent: Agent = {
                id: `${userId}-${Date.now()}`,
                userId,
                intervalId: null,
                bot: agentBot,
            };

            // Check if wallet exists for this agent
            const { data: agentWallet, error: walletError } = await supabase
                .from('agents')
                .select('wallet_address, wallet_secret')
                .eq('user_id', userId)
                .single();

            if (walletError) {
                throw new Error(`Error fetching wallet data: ${walletError.message}`);
            }

            if (!agentWallet.wallet_address || !agentWallet.wallet_secret) {
                // Generate new wallet
                const keypair = Keypair.generate();
                const publicKey = keypair.publicKey.toBase58();
                const privateKey = bs58.encode(keypair.secretKey);

                // Encrypt private key
                const encryptedPrivateKey = encrypt(privateKey);

                // Update agent with new wallet info
                const { error: updateError } = await supabase
                    .from('agents')
                    .update({ 
                        wallet_address: publicKey,
                        wallet_secret: encryptedPrivateKey
                    })
                    .eq('user_id', userId);

                if (updateError) {
                    throw new Error(`Error updating wallet data: ${updateError.message}`);
                }

                console.log(`New wallet created for user ${userId}`);
            }

    
            agent.intervalId = setInterval(() => {
                this.runAgentTask(agent);
            }, 20000);
    
            this.agents.set(userId, agent);
            console.log(`Agent created and running for user: ${userId}`);
        }
        catch (error) {
            console.error("Failed to initialize agent:", error);
        }
    }
  
    stopAgent(userId: string) {
        const agent = this.agents.get(userId);
        if (agent && agent.intervalId) {
            clearInterval(agent.intervalId);
            this.agents.delete(userId);
            console.log(`Agent for user ${userId} stopped.`);
        }
    }
  
    private async runAgentTask(agent: Agent) {
        try {
            // Get agent's wallet
            const keypair = await this.getAgentWallet(agent.userId);
            const wallet = new Wallet(keypair);
            const connection = new Connection(RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)]);

            const solBalanceInSol = await getTokenBalance(connection, wallet, INPUT_ADDRESS);
            const solBalanceInLamports = Math.floor(solBalanceInSol * LAMPORTS_PER_SOL);


            // Fetch agent data from Supabase
            const { data: agentData, error } = await supabase
                .from('agents')
                .select(`
                    liquidity_min,
                    liquidity_max,
                    liquidity_importance,
                    age_min,
                    age_importance,
                    volume_min,
                    volume_max,
                    volume_importance,
                    market_cap_min,
                    market_cap_importance,
                    sentiment_importance,
                    whale_importance,
                    sell_floor,
                    sell_ceiling   
                `)
                .eq('user_id', agent.userId)
                .single();

            if (error) {
                throw new Error(`Failed to fetch agent data: ${error.message}`);
            }

            if (!agentData) {
                throw new Error(`No agent data found for user ${agent.userId}`);
            }

            // Store the data in the agent instance for use in trading logic
            const agentPreferences = {
                liquidity: { min: agentData.liquidity_min, max: agentData.liquidity_max, importance: agentData.liquidity_importance },
                age: { min: agentData.age_min, importance: agentData.age_importance },
                volume: { min: agentData.volume_min, max: agentData.volume_max, importance: agentData.volume_importance },
                marketCap: { min: agentData.market_cap_min, importance: agentData.market_cap_importance },
                sentiment: { importance: agentData.sentiment_importance },
                whale: { importance: agentData.whale_importance },
                sellFloor: agentData.sell_floor,
                sellCeiling: agentData.sell_ceiling
            };

            // Fetch slot data for this agent
            const { data: slotData, error: slotError } = await supabase
                .from('agent_slots')
                .select(`
                    buy_price,
                    buy_amount,
                    buy_address,
                    state,
                    slot_id
                `)
                .eq('user_id', agent.userId) as { 
                    data: SlotData[] | null; 
                    error: PostgrestError | null 
                };

            if (slotError) {
                throw new Error(`Failed to fetch slot data: ${slotError.message}`);
            }

            if (!slotData || slotData.length !== NUM_SLOTS) {
                throw new Error(`Expected ${NUM_SLOTS} slots for user ${agent.userId}, found ${slotData?.length || 0}`);
            }

            // Process each slot
            for (const slot of slotData) {
                try {
                    // Skip empty slots                   

                    // Example skeleton for slot-specific actions:
                    await this.processSlot(
                        agent.userId,
                        slot,
                        agentPreferences,
                        agent,
                        slot.slot_id
                    );

                } catch (slotError: unknown) {
                    console.error(`Error processing slot for token ${slot.buy_address}:`, slotError);
                    // Continue with next slot even if one fails
                    continue;
                }
            }

        } catch (error: any) {
            console.error("Error:", error.message || error);
        }
    }

    private async processSlot(
        userId: string,
        slot: SlotData,
        preferences: AgentPreferences,
        agent: Agent,
        slotId: string
    ) {
        console.log(`Processing slot for user ${userId} with token ${slot.buy_address}`);
        console.log(`Current state: ${slot.state ? 'Active/Bought' : 'Inactive/Sold'}`);

        try {
            if (slot.state) {
                const sellFloor = preferences.sellFloor;
                const sellCeiling = preferences.sellCeiling;
                console.log("Sell ceiling: ", sellCeiling, "Sell floor: ", sellFloor);
                const currentPrice = await getPrice(slot.buy_address);
                
                if (currentPrice === null) {
                    console.log(`Could not fetch current price for token ${slot.buy_address}`);
                    return;
                }

                // Get stored buy price for this specific slot
                const { data: slotData, error: slotError } = await supabase
                    .from('agent_slots')
                    .select('buy_price, buy_address, buy_amount')  // Added needed fields
                    .eq('slot_id', slotId)
                    .eq('user_id', userId)
                    .single();

                if (slotError || !slotData) {
                    console.error(`Error fetching slot data for slot ${slotId}: ${slotError?.message}`);
                    return;
                }

                const priceRatio = currentPrice / (slotData.buy_price / LAMPORTS_PER_SOL); // Convert lamports to SOL
                console.log(`Price ratio for ${slot.buy_address}: ${priceRatio}`);
                console.log(`Sell ceiling: ${sellCeiling}, Sell floor: ${sellFloor}`);

                if (priceRatio >= sellCeiling || priceRatio <= sellFloor) {
                    console.log(`Triggering sell for token ${slot.buy_address}`);
                    console.log(`Reason: Price ratio ${priceRatio} is ${priceRatio >= sellCeiling ? 'above ceiling' : 'below floor'}`);
                    
                    try {
                        const connection = new Connection(RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)]);
                        const keypair = await this.getAgentWallet(userId);
                        const wallet = new Wallet(keypair);
                        
                        // Check if token exists and has liquidity
                        const tokenBalance = await getTokenBalance(connection, wallet, slot.buy_address);
                        if (!tokenBalance) {
                            console.log(`No balance found for token ${slot.buy_address}`);
                            return;
                        }

                        // Get token decimals and calculate proper amount
                        const decimals = await getTokenDecimals(connection, slot.buy_address);
                        const actualBalance = await getTokenBalance(connection, wallet, slot.buy_address);
                        
                        // Convert actual balance to raw units with proper decimals
                        const actualBalanceRaw = Math.floor(actualBalance * Math.pow(10, decimals));
                        
                        // Use the actual balance as the sell amount - we want to sell everything
                        const sellAmount = actualBalanceRaw;

                        console.log(`Selling amount: ${sellAmount} (${actualBalance} tokens with ${decimals} decimals)`);
                        
                        if (sellAmount <= 0) {
                            console.log(`Invalid sell amount for token ${slot.buy_address}`);
                            return;
                        }

                        await makeTrade(
                            slot.buy_address,
                            INPUT_ADDRESS,
                            sellAmount,
                            SLIPPAGE,
                            wallet
                        );

                        const newCurrentPrice = await getPrice(slot.buy_address);
                
                        if (newCurrentPrice === null) {
                            console.log(`Could not fetch current price for token ${slot.buy_address}`);
                            return;
                        }

                        // Calculate profit using original amount for accuracy
                        const currentTokenValue = newCurrentPrice * slot.buy_amount * LAMPORTS_PER_SOL;
                        const profit = currentTokenValue - BUY_AMOUNT_LAMPORTS;

                        // Get and update total profit
                        const { data: currentProfit } = await supabase
                            .from('agents')
                            .select('total_profit')
                            .eq('user_id', userId)
                            .single();

                        await supabase.from('agents')
                            .update({ 
                                total_profit: (currentProfit?.total_profit || 0) + profit
                            })
                            .eq('user_id', userId);

                        // Update slot state
                        await supabase.from('agent_slots')
                            .update({ state: false })
                            .eq('slot_id', slotId)
                            .eq('user_id', userId);

                        console.log(`Sell completed. Profit: ${profit} lamports`);
                    } catch (error) {
                        console.error(`Sell trade failed for token ${slot.buy_address}:`, error);
                    }
                }
            } else {
                const connection = new Connection(RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)]);
                const keypair = await this.getAgentWallet(userId);
                const wallet = new Wallet(keypair);

                // Add debug logging for balance checks
                const solBalance = await getTokenBalance(connection, wallet, INPUT_ADDRESS);
                const solBalanceLamports = Math.floor(solBalance * LAMPORTS_PER_SOL);
                
                console.log(`Wallet SOL balance: ${solBalance} SOL (${solBalanceLamports} lamports)`);
                
                if (solBalanceLamports < BUY_AMOUNT_LAMPORTS) {
                    console.log(`Insufficient SOL balance (${solBalanceLamports} lamports). Minimum required: ${BUY_AMOUNT_LAMPORTS} lamports`);
                    return;
                }

                const bot = agent.bot;

                // Get all currently active slots for this user
                const { data: activeSlots, error: slotsError } = await supabase
                    .from('agent_slots')
                    .select('buy_address')
                    .eq('user_id', userId)
                    .eq('state', true);

                if (slotsError) {
                    throw new Error(`Error fetching active slots: ${slotsError.message}`);
                }

                // Create array of tokens to exclude
                const excludedTokens = activeSlots?.map(slot => slot.buy_address) || [];

                // Fetch token and whale data as before
                const { data: tokenData, error: tokenError } = await supabase
                    .from('trending_token_data')
                    .select(`
                        token_id,
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
                        5min_price_change,
                        1hour_price_change,
                        6hour_price_change,
                        24hour_price_change,
                        age_hours
                    `) as { data: TokenData[] | null; error: PostgrestError | null };

                if (tokenError) {
                    throw new Error(`Error fetching token data: ${tokenError.message}`);
                }

                // Filter out tokens that are already in use in other slots
                const availableTokens = tokenData?.filter(token => 
                    !excludedTokens.includes(token.token_address)
                ) || [];

                // If no unique tokens available, skip
                if (availableTokens.length === 0) {
                    console.log("No unique tokens available for purchase");
                    return;
                }

                // Add a helper function for filtering tokens
                function filterTokensByPreferences(tokens: TokenData[], preferences: AgentPreferences): TokenData[] {
                    return tokens.filter(token => {
                        // Skip tokens with missing required data
                        if (!token.liquidity || !token.volume_24_hr || !token.market_cap || !token.age_hours) {
                            return false;
                        }

                        // Check against minimum requirements
                        const meetsLiquidity = token.liquidity >= preferences.liquidity.min && 
                                              token.liquidity <= preferences.liquidity.max;
                        
                        const meetsVolume = token.volume_24_hr >= preferences.volume.min && 
                                            token.volume_24_hr <= preferences.volume.max;
                        
                        const meetsMarketCap = token.market_cap >= preferences.marketCap.min;
                        
                        const meetsAge = token.age_hours >= preferences.age.min;

                        return meetsLiquidity && meetsVolume && meetsMarketCap && meetsAge;
                    });
                }

                // Filter tokens based on user preferences
                const filteredTokens = filterTokensByPreferences(availableTokens, preferences);
                
                console.log(`Filtered from ${availableTokens.length} to ${filteredTokens.length} tokens based on preferences`);

                if (filteredTokens.length === 0) {
                    console.log("No tokens match preferences");
                    return;
                }

                const systemPrompt = `You are a trading agent whose aim is to maximize profit while maintaining a diverse portfolio. 
                Given token data, output only a valid Solana token address to buy from the available tokens, or "SKIP" if no good options exist.
                Output "SKIP" unless the token shows very strong potential for profit.`;

                const humanPrompt = 
                    `Importance Metrics (out of 100):
                    Liquidity: ${preferences.liquidity.importance}
                    Age: ${preferences.age.importance}
                    Volume: ${preferences.volume.importance}
                    Market Cap: ${preferences.marketCap.importance}

                    Available Tokens:
                    ${filteredTokens.map(t => `
                        Token: ${t.token_address}
                        - Price: ${t.price || 'Unknown'} USD
                        - Volume 24h: ${t.volume_24_hr || 'Unknown'} USD 
                        - Liquidity: ${t.liquidity || 'Unknown'} USD
                        - Market Cap: ${t.market_cap || 'Unknown'} USD
                        - Last Hour: ${t.last_hour_buys} buys, ${t.last_hour_sells} sells
                        - Last 5 minutes: ${t.last_5min_buys} buys, ${t.last_5min_sells} sells
                        - Price Changes:
                        5 minutes: ${t['5min_price_change']}%
                        1 hour: ${t['1hour_price_change']}%
                        6 hours: ${t['6hour_price_change']}%
                        24 hours: ${t['24hour_price_change']}%
                        - Age: ${t.age_hours} hours
                    `).join('\n')}

                    Output only the token address or "SKIP".`;

                const response = await bot.invoke([
                    new SystemMessage(systemPrompt),
                    new HumanMessage(humanPrompt)
                ]);

                const selectedTokenAddress = response.content.trim();
                
                // Skip if LLM suggests no good options or returns invalid address
                if (selectedTokenAddress === "SKIP" || selectedTokenAddress.length < 32) {
                    console.log("No suitable tokens found for purchase");
                    return;
                }

                try {
                    // Verify the token address is valid before attempting trade
                    if (!selectedTokenAddress.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
                        console.log("Invalid token address format");
                        return;
                    }

                    // Attempt the trade
                    await makeTrade(
                        INPUT_ADDRESS,
                        selectedTokenAddress,
                        BUY_AMOUNT_LAMPORTS,
                        SLIPPAGE,
                        wallet
                    );

                    // Only proceed with price check and DB update if trade succeeds
                    const tokenPriceInSol = await getPrice(selectedTokenAddress);
                    if (!tokenPriceInSol) {
                        throw new Error(`Could not get price for token ${selectedTokenAddress}`);
                    }
                    
                    const tokenPriceInLamports = tokenPriceInSol * LAMPORTS_PER_SOL;
                    // Floor the token amount to ensure it's an integer
                    const tokenAmountInLamports = Math.floor(BUY_AMOUNT_LAMPORTS / tokenPriceInLamports);

                    await supabase
                        .from('agent_slots')
                        .update({ 
                            state: true,
                            buy_address: selectedTokenAddress,
                            buy_price: tokenPriceInLamports,
                            buy_amount: tokenAmountInLamports
                        })
                        .eq('user_id', agent.userId)
                        .eq('slot_id', slotId);
                    
                    console.log(`Slot ${slot.buy_address}: Updated with token ${selectedTokenAddress} for purchase`);
                } catch (error) {
                    console.error(`Trade failed for token ${selectedTokenAddress}:`, error);
                    // Continue with next iteration without updating database
                }
            }

            // Update state if needed
            // await supabase
            //     .from('agent_slots')
            //     .update({ state: newState })
            //     .eq('user_id', userId)
            //     .eq('buy_address', slot.buy_address);

        } catch (error) {
            console.error(`Error processing slot state for token ${slot.buy_address}:`, error);
        }
    }

    private async getAgentWallet(userId: string): Promise<Keypair> {
        const { data: agentWallet, error: walletError } = await supabase
            .from('agents')
            .select('wallet_secret')
            .eq('user_id', userId)
            .single();

        if (walletError || !agentWallet?.wallet_secret) {
            throw new Error(`Error fetching wallet data: ${walletError?.message}`);
        }

        const privateKey = decrypt(agentWallet.wallet_secret);
        return Keypair.fromSecretKey(bs58.decode(privateKey));
    }
}

// Get token data from data-collector
async function getTrendingTokens(): Promise<TokenData[]> {
  const response = await fetch('http://data-collector:3001/trending-tokens');
  if (!response.ok) throw new Error('Failed to fetch trending tokens');
  const data = await response.json();
  console.log('Raw token data:', JSON.stringify(data[0], null, 2)); // Full debug output
  return data;
}

// Get user data directly from Supabase
async function getUserData(userId: string) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
    
  if (error) throw error;
  return data;
}
