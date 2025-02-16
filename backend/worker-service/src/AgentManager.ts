import { HumanMessage, SystemMessage } from "@langchain/core/messages";
// import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
// import { createReactAgent } from "@langchain/langgraph/prebuilt";
// import { MemorySaver } from "@langchain/langgraph";
// import { Keypair } from '@solana/web3.js';
// import bs58 from 'bs58';
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
const BUY_AMOUNT_LAMPORTS: number = 1000000; // Already in lamports
const SLIPPAGE: number = 1500;
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
    liquidity: { value: number; bin: string };
    history: { value: number; bin: string };
    marketCap: { value: number; bin: string };
    sentiment: { value: number; bin: string };
    whale: { value: number; bin: string };
    risk: { value: number; bin: string };
}

// Add these interfaces at the top of the file with other interfaces
interface TokenData {
    token_id: string;
    token_address: string;
    price: number;
    volume_24_hr: number;
    liquidity: number;
    market_cap: number;
    last_hour_buys: number;
    last_hour_sells: number;
    last_5min_buys: number;
    last_5min_sells: number;
    description: string;
}

interface WhaleTokenData {
    token_address: string;
    count: number;
    volume: number;
}

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_KEY!
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
            
            // const memory = new LimitedMemorySaver(10);
  
            // const agentBot = createReactAgent({
            //     llm,
            //     tools: [],
            //     checkpointSaver: memory,
            // });
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
                    liquidity_num,
                    liquidity_bin,
                    history_num,
                    history_bin,
                    market_cap_num,
                    market_cap_bin,
                    sentiment_num,
                    sentiment_bin,
                    whale_num,
                    whale_bin,
                    risk_num,
                    risk_bin
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
                liquidity: {
                    value: agentData.liquidity_num,
                    bin: agentData.liquidity_bin
                },
                history: {
                    value: agentData.history_num,
                    bin: agentData.history_bin
                },
                marketCap: {
                    value: agentData.market_cap_num,
                    bin: agentData.market_cap_bin
                },
                sentiment: {
                    value: agentData.sentiment_num,
                    bin: agentData.sentiment_bin
                },
                whale: {
                    value: agentData.whale_num,
                    bin: agentData.whale_bin
                },
                risk: {
                    value: agentData.risk_num,
                    bin: agentData.risk_bin
                }
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

            // Execute trade with the fetched preferences
            // const tradeParams = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v So11111111111111111111111111111111111111112 500000 1500";
            // const [inputAddress, outputAddress, amountStr, slippageStr] = tradeParams.split(' ');
            
            // await makeTrade(
            //     inputAddress,
            //     outputAddress,
            //     parseInt(amountStr),
            //     parseInt(slippageStr)
            // ).catch(error => {
            //     console.error('Error in makeTrade:', error);
            //     process.exit(1);
            // });

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
              console.log("Risk value: ", preferences.risk.value);
                // const sellCeiling = 1.25 * preferences.risk.value / 100 + 1.25;
                const sellCeiling = 1.05
                // const sellFloor = -0.5 * preferences.risk.value / 100 + 0.75;
                const sellFloor = 0.95
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

                        // Calculate profit using original amount for accuracy
                        const currentTokenValue = currentPrice * slot.buy_amount * LAMPORTS_PER_SOL;
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
                        description
                    `) as { data: TokenData[] | null; error: PostgrestError | null };

                if (tokenError) {
                    throw new Error(`Error fetching token data: ${tokenError.message}`);
                }

                // Filter out tokens that are already in use in other slots
                const availableTokens = tokenData?.filter(token => 
                    !excludedTokens.includes(token.token_address)
                ) || [];

                const { data: whaleData, error: whaleError } = await supabase
                    .from('whale_token_data')
                    .select(`
                        token_address,
                        count,
                        volume
                    `) as { data: WhaleTokenData[] | null; error: PostgrestError | null };

                if (whaleError) {
                    throw new Error(`Error fetching whale data: ${whaleError.message}`);
                }

                // Store filtered data in JSON format
                const tokenDataJson = JSON.stringify(availableTokens);
                const whaleDataJson = JSON.stringify(whaleData || []);

                const systemPrompt = `You are a trading agent. Given token data and preferences, output only a valid Solana token address to buy, or "SKIP". 
                    Consider diversification as a plus but prioritize token quality. Use all fields in the JSON data for analysis.`;

                const humanPrompt = `Preferences: ${JSON.stringify(preferences)}
                    Tokens: ${tokenDataJson}
                    Whale data: ${whaleDataJson}
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
