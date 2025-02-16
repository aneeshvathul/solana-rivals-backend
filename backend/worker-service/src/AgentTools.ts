import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Tool } from '@langchain/core/tools';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { getAssociatedTokenAddress } from '@solana/spl-token';

dotenv.config({ path: '../.env' });


interface DexPair {
    quoteToken: {
        symbol: string;
    };
    priceNative?: string;
}

const RPC_URLS = process.env.RPC_URLS!.split(',');

async function getTokenBalance(
    connection: Connection,
    wallet: Wallet,
    tokenMint: string
): Promise<number> {
    try {
        // Special handling for SOL
        if (tokenMint.toLowerCase() === "so11111111111111111111111111111111111111112") {
            try {
                console.log("Checking SOL balance for wallet:", wallet.publicKey.toString());
                const balance = await connection.getBalance(wallet.publicKey);
                console.log("Raw SOL balance:", balance);
                return balance / LAMPORTS_PER_SOL;
            } catch (solError) {
                console.error("Error getting SOL balance:", solError);
                throw solError; // Propagate the error instead of returning 0
            }
        }

        // For other tokens...
        const tokenAccount = await getAssociatedTokenAddress(
            new PublicKey(tokenMint),
            wallet.publicKey
        );

        try {
            const balance = await connection.getTokenAccountBalance(tokenAccount);
            return Number(balance.value.uiAmount);
        } catch (e) {
            // If token account doesn't exist, balance is 0
            return 0;
        }
    } catch (error) {
        console.error("Error getting token balance:", error);
        return 0;
    }
}

async function makeTrade(
    inputAddress: string,
    outputAddress: string,
    amount: number,
    slippage: number,
    wallet: Wallet
): Promise<void> {
    const connection = new Connection(RPC_URLS[Math.floor(Math.random() * RPC_URLS.length)], {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
    });

    try {
        // Log initial balances
        console.log("\nInitial Balances:");
        console.log(`Input Token (${inputAddress}): ${await getTokenBalance(connection, wallet, inputAddress)}`);
        console.log(`Output Token (${outputAddress}): ${await getTokenBalance(connection, wallet, outputAddress)}\n`);

        // Get quote
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputAddress}&outputMint=${outputAddress}&amount=${amount}&slippageBps=${slippage}`
        );
        
        const quote = await quoteResponse.json();
        console.log("Quote received:", quote);

        if (quote.error) {
            throw new Error(`Invalid quote response: ${quote.error}`);
        }

        // Get swap transaction
        const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
            })
        });

        const swapData = await swapResponse.json();
        console.log("Swap transaction received");

        // Sign and send transaction
        const swapTransaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
        swapTransaction.sign([wallet.payer]);
        
        const txid = await connection.sendTransaction(swapTransaction, { maxRetries: 3 });
        console.log("Transaction sent:", txid);

        // Wait for confirmation with retries
        let retries = 3;
        while (retries > 0) {
            try {
                const confirmation = await connection.confirmTransaction(txid, 'confirmed');
                if (confirmation.value.err) {
                    throw new Error(`Transaction failed: ${confirmation.value.err}`);
                }
                console.log("Transaction confirmed");
                return;
            } catch (error) {
                retries--;
                if (retries === 0) throw error;
                console.log(`Retrying confirmation... ${retries} attempts left`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
            }
        }
    } catch (error) {
        throw error;
    }
}

/**
 * Gets the current price of a token in SOL given its contract address
 * @param tokenAddress The contract address of the token
 * @returns The current price in SOL as a decimal number, or null if price cannot be fetched
 */
async function getPrice(tokenAddress: string): Promise<number | null> {
    try {
        // DexScreener API endpoint
        const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data?.pairs || data.pairs.length === 0) {
            return null;
        }

        // Find a SOL pair if available
        const solPair = data.pairs.find((pair: DexPair) => 
            pair.quoteToken.symbol === 'SOL' || 
            pair.quoteToken.symbol === 'WSOL'
        );
        
        if (solPair) {
            return solPair.priceNative ? parseFloat(solPair.priceNative) : null;
        }
        
        // If no SOL pair, get USD price and convert using SOL price
        const usdPair = data.pairs[0];
        if (!usdPair.priceUsd) {
            return null;
        }
        
        // Fetch SOL price in USD
        const solResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
        
        if (!solResponse.ok) {
            throw new Error(`HTTP error! Status: ${solResponse.status}`);
        }
        
        const solData = await solResponse.json();
        
        if (!solData?.pairs || solData.pairs.length === 0 || !solData.pairs[0].priceUsd) {
            return null;
        }
        
        const solPriceUsd = parseFloat(solData.pairs[0].priceUsd);
        const tokenPriceUsd = parseFloat(usdPair.priceUsd);
        
        // Convert USD price to SOL
        return tokenPriceUsd / solPriceUsd;
    } catch (error) {
        console.error(`Error fetching price for token ${tokenAddress}:`, error);
        return null;
    }
}

async function getTokenDecimals(
    connection: Connection,
    tokenMint: string
): Promise<number> {
    if (tokenMint.toLowerCase() === "so11111111111111111111111111111111111111112") {
        return 9; // SOL has 9 decimals
    }
    
    try {
        const info = await connection.getParsedAccountInfo(new PublicKey(tokenMint));
        if (info.value?.data && 'parsed' in info.value.data) {
            return info.value.data.parsed.info.decimals;
        }
        return 9; // Default to 9 if we can't get the info
    } catch (error) {
        console.error(`Error getting decimals for ${tokenMint}:`, error);
        return 9; // Default to 9 on error
    }
}

export { makeTrade, getPrice, getTokenBalance, getTokenDecimals }