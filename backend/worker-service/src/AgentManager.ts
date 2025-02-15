import { HumanMessage } from "@langchain/core/messages";
import { Tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MemorySaver } from "@langchain/langgraph";
// import { Keypair } from '@solana/web3.js';
// import bs58 from 'bs58';
import { makeTrade } from "./AgentTools";
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

  // Custom memory saver class that limits cached messages
  class LimitedMemorySaver extends MemorySaver {
    private maxMessages: number;
    private messages: any[] = [];

    constructor(maxMessages: number = 10) {
      super();
      this.maxMessages = maxMessages;
    }

    async saveCheckpoint(checkpoint: any) {
      this.messages.push(checkpoint);
      
      // Remove oldest messages if we exceed the limit
      if (this.messages.length > this.maxMessages) {
        this.messages = this.messages.slice(-this.maxMessages);
      }
    }

    async loadCheckpoint() {
      return this.messages;
    }

    async clear() {
      this.messages = [];
    }
  }

  function validateEnvironment(): void {
    const missingVars: string[] = [];

    const requiredVars = ["OPENAI_API_KEY", "RPC_URL"];
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
    settings: any;
    intervalId: NodeJS.Timeout | null;
    bot: any;
    config: any;
  };
  
  export class AgentManager {
    private agents: Map<string, Agent> = new Map();
  
    async createAgent(userId: string, settings: any) {
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
      
        // // create wallet logic here
        // const keypair = Keypair.generate();

        // // insert into database, encrypt private key
        // const publicKey = keypair.publicKey.toBase58();
        // const privateKey = bs58.encode(keypair.secretKey)

        
        const memory = new LimitedMemorySaver(10);
  
        const agentBot = createReactAgent({
          llm,
          tools: [],
          checkpointSaver: memory,
        });

        const agentConfig = { configurable: { thread_id: "Solana Agent Kit!" } };
  
        const agent: Agent = {
          id: `${userId}-${Date.now()}`,
          userId,
          settings,
          intervalId: null,
          bot: agentBot,
          config: agentConfig
        };
    
        agent.intervalId = setInterval(() => {
          this.runAgentTask(agent);
        }, 60000); // Adjust task frequency as needed
    
        this.agents.set(userId, agent);
        console.log(`Agent created and running for user: ${userId}`);
      }
      catch (error) {
        console.error("Failed to initialize agent:", error);
      }
    }
  
    updateAgentSettings(userId: string, newSettings: any) {
      const agent = this.agents.get(userId);
      if (agent) {
        agent.settings = newSettings;
        console.log(`Updated settings for agent ${userId}`);
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
        // tradeParams to be set by llm logic
        const tradeParams = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v So11111111111111111111111111111111111111112 500000 1500";
        const [inputAddress, outputAddress, amountStr, slippageStr] = tradeParams.split(' ');
        
        await makeTrade(
            inputAddress,
            outputAddress,
            parseInt(amountStr),
            parseInt(slippageStr)
        ).catch(error => {
          console.error('Error in makeTrade:', error);
          process.exit(1);
      });

    } catch (error: any) {
        console.error("Error:", error.message || error);
    }
  }
}