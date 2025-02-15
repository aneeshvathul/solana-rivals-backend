import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Tool } from '@langchain/core/tools';
import bs58 from 'bs58';

async function getTokenBalance(
    connection: Connection,
    wallet: Wallet,
    tokenMint: string
): Promise<number> {
    // Handle SOL balance
    if (tokenMint.toLowerCase() === "so11111111111111111111111111111111111111112") {
        const balance = await connection.getBalance(wallet.publicKey);
        return balance / 1e9; // Convert lamports to SOL
    }

    // Find token account
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { programId: TOKEN_PROGRAM_ID }
    );

    // Find the specific token account
    const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.mint === tokenMint
    );

    if (!tokenAccount) {
        return 0;
    }

    // Get balance and decimals
    const balance = tokenAccount.account.data.parsed.info.tokenAmount.amount;
    const decimals = tokenAccount.account.data.parsed.info.tokenAmount.decimals;
    
    return Number(balance) / Math.pow(10, decimals);
}

async function makeTrade(
    inputAddress: string,
    outputAddress: string,
    amount: number,
    slippage: number
) {
    // Create connection
    const connection = new Connection(process.env.RPC_URL!);
    
    // Setup wallet
    const wallet = new Wallet(
        Keypair.fromSecretKey(
            bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY || '')
        )
    );

    // Get initial balances
    console.log('\nInitial Balances:');
    const initialInputBalance = await getTokenBalance(connection, wallet, inputAddress);
    const initialOutputBalance = await getTokenBalance(connection, wallet, outputAddress);
    console.log(`Input Token (${inputAddress}): ${initialInputBalance}`);
    console.log(`Output Token (${outputAddress}): ${initialOutputBalance}`);
    
    // Fixed URL formatting
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputAddress}&outputMint=${outputAddress}&amount=${amount}&slippageBps=${slippage}`;

    // Get quote
    const quoteResponse = await (await fetch(quoteUrl)).json();
    console.log('\nQuote received:', quoteResponse);

    // Check for valid quote
    if (!quoteResponse || !quoteResponse.routePlan) {
        throw new Error('Invalid quote response');
    }

    // Get swap transaction
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true
        })
    });

    const { swapTransaction } = await swapResponse.json();

    if (!swapTransaction) {
        throw new Error('No swap transaction received');
    }

    console.log('Swap transaction received');

    // Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign the transaction
    transaction.sign([wallet.payer]);

    // Get latest blockhash
    const latestBlockHash = await connection.getLatestBlockhash();

    // Execute transaction
    const rawTransaction = transaction.serialize();
    const txid = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2
    });

    console.log('Transaction sent:', txid);

    // Confirm transaction
    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: txid
    });

    console.log(`Transaction confirmed: https://solscan.io/tx/${txid}`);

}

export { makeTrade}