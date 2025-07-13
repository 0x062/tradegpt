import 'dotenv/config';
import axios from 'axios';
import { ethers } from 'ethers';
import chalk from 'chalk';

// --- Logger Sederhana ---
const logger = {
    info: (msg) => console.log(chalk.green(`[✅] ${msg}`)),
    warn: (msg) => console.log(chalk.yellow(`[⚠️] ${msg}`)),
    error: (msg) => console.log(chalk.red(`[❌] ${msg}`)),
    step: (msg) => console.log(chalk.white(`[▶] ${msg}`)),
    loading: (msg) => console.log(chalk.cyan(`[🔄] ${msg}`)),
};

// --- Konfigurasi dari .env ---
const {
    PRIVATE_KEY,
    NUMBER_OF_ACTIONS,
    MIN_SWAP_AMOUNT,
    MAX_SWAP_AMOUNT,
    DELAY_SHORT_MS,
    DELAY_MEDIUM_MS,
    DELAY_LONG_MS
} = process.env;

if (!PRIVATE_KEY) {
    logger.error('PRIVATE_KEY tidak ditemukan di file .env. Harap isi terlebih dahulu.');
    process.exit(1);
}

// --- Variabel & Konstanta Global ---
const networkConfig = {
    rpc: 'https://evmrpc-testnet.0g.ai/',
    explorer: 'https://chainscan-galileo.0g.ai/',
};
const provider = new ethers.JsonRpcProvider(networkConfig.rpc);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const usdtAddress = '0x217C6f12d186697b16dE9e1ae9F85389B93BdB30';
const uniswapRouterAddress = '0xDCd7d05640Be92EC91ceb1c9eA18e88aFf3a6900';
const tokens = { CSYN: '0xd12F4750a60c4B22680264E018Bb1664Ca23aF40', MTP: '0x5506EBd25960Fb30704c2Dc548c3dA7351277eBa', /* ... other tokens */ };
const tradeableTokens = Object.keys(tokens);

const erc20ABI = ['function balanceOf(address account) view returns (uint256)', 'function decimals() view returns (uint8)', 'function approve(address spender, uint256 amount) returns (bool)'];
const uniswapRouterABI = ['function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)'];

// --- Fungsi Helper ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, parseInt(ms)));

const getHeaders = () => ({
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'Referer': 'https://0g.app.tradegpt.finance/',
});

const getRandomPrompt = () => {
    const prompts = ["What's the value of my portfolio?", "What can I do on TradeGPT?", "What is the price of CSYN?", "Need alpha"];
    return prompts[Math.floor(Math.random() * prompts.length)];
};

// --- Fungsi Inti ---
async function checkWalletInfo() {
    logger.loading(`Mengecek status wallet: ${wallet.address}`);
    try {
        const usdtContract = new ethers.Contract(usdtAddress, erc20ABI, provider);
        const nativeBalance = await provider.getBalance(wallet.address);
        const usdtBalance = await usdtContract.balanceOf(wallet.address);
        const usdtDecimals = await usdtContract.decimals();
        logger.info(`Saldo: ${ethers.formatEther(nativeBalance)} OG | ${ethers.formatUnits(usdtBalance, usdtDecimals)} USDT`);
        return { usdtBalance, usdtDecimals, nativeBalance };
    } catch (error) {
        logger.error(`Gagal mengecek info wallet: ${error.message}`);
        return null;
    }
}

async function sendChatRequest(promptText) {
    logger.loading(`Mengirim chat: "${promptText}"`);
    const url = 'https://trade-gpt-800267618745.herokuapp.com/ask/ask';
    const payload = {
        chainId: 16601,
        user: wallet.address,
        questions: [{ question: promptText, /* ... data lainnya */ }],
        testnetOnly: true,
    };
    try {
        const response = await axios.post(url, payload, { headers: getHeaders() });
        logger.info('Chat berhasil dikirim.');
        return response.data;
    } catch (error) {
        logger.error(`Gagal mengirim chat: ${error.message}`);
        return null;
    }
}

async function performSwap(amountUSDT, targetTokenSymbol) {
    const targetTokenAddress = tokens[targetTokenSymbol];
    logger.step(`Mempersiapkan swap ${amountUSDT} USDT -> ${targetTokenSymbol}`);
    try {
        const { usdtBalance, usdtDecimals } = await checkWalletInfo();
        const amountIn = ethers.parseUnits(amountUSDT.toString(), usdtDecimals);

        if (usdtBalance < amountIn) throw new Error('Saldo USDT tidak mencukupi.');

        const swapPrompt = `Swap ${amountUSDT} USDT to ${targetTokenSymbol}`;
        const aiResponse = await sendChatRequest(swapPrompt);
        if (!aiResponse) throw new Error('Tidak mendapat respons dari AI untuk swap.');
        
        const swapData = JSON.parse(aiResponse.questions[0].answer[0].content);
        if (!swapData?.amountOutMin) throw new Error('Data swap dari AI tidak valid.');

        const targetTokenContract = new ethers.Contract(targetTokenAddress, erc20ABI, provider);
        const targetTokenDecimals = await targetTokenContract.decimals();
        const amountOutMin = ethers.parseUnits(swapData.amountOutMin.toString(), targetTokenDecimals);
        
        const usdtContract = new ethers.Contract(usdtAddress, erc20ABI, wallet);
        logger.loading(`Melakukan approve ${amountUSDT} USDT...`);
        const approveTx = await usdtContract.approve(uniswapRouterAddress, amountIn);
        await approveTx.wait();
        logger.info(`Approve berhasil. Tx: ${approveTx.hash.slice(0,10)}...`);

        await delay(DELAY_SHORT_MS);

        const router = new ethers.Contract(uniswapRouterAddress, uniswapRouterABI, wallet);
        logger.loading(`Melakukan swap...`);
        const tx = await router.swapExactTokensForTokens(amountIn, amountOutMin, [usdtAddress, targetTokenAddress], wallet.address, Math.floor(Date.now() / 1000) + 60 * 20);
        await tx.wait();
        logger.info(`Swap berhasil! Tx: ${networkConfig.explorer}/tx/${tx.hash}`);

        // Log transaction (off-chain)
        await axios.post('https://trade-gpt-800267618745.herokuapp.com/log/logTransaction', {
            walletAddress: wallet.address,
            txHash: tx.hash,
            // ... data lainnya
        }, { headers: getHeaders() });
        logger.info('Transaksi berhasil dilaporkan ke server.');

    } catch (error) {
        logger.error(`Proses swap gagal: ${error.message}`);
    }
}


// --- Alur Eksekusi Utama ---
async function runBot() {
    logger.step('====== Memulai Bot Auto TX TradeGPT (Single Account) ======');
    await checkWalletInfo();
    console.log('');

    const numActions = parseInt(NUMBER_OF_ACTIONS) || 3;
    logger.step(`Akan menjalankan ${numActions} siklus (Chat + Swap)...`);

    for (let i = 0; i < numActions; i++) {
        logger.step(`--- Siklus ${i + 1}/${numActions} ---`);
        try {
            // 1. Kirim chat acak
            await sendChatRequest(getRandomPrompt());
            await delay(DELAY_SHORT_MS);
            
            // 2. Lakukan swap acak
            const randomAmount = (Math.random() * (parseFloat(MAX_SWAP_AMOUNT) - parseFloat(MIN_SWAP_AMOUNT)) + parseFloat(MIN_SWAP_AMOUNT)).toFixed(6);
            const randomToken = tradeableTokens[Math.floor(Math.random() * tradeableTokens.length)];
            await performSwap(parseFloat(randomAmount), randomToken);

        } catch (error) {
            logger.error(`Terjadi kesalahan pada siklus ${i + 1}: ${error.message}`);
        }
        logger.step(`Siklus ${i + 1} selesai. Mengambil jeda...`);
        await delay(DELAY_MEDIUM_MS);
    }

    logger.step('====== Semua siklus selesai. Mengecek status akhir. ======');
    await checkWalletInfo();
    await delay(DELAY_LONG_MS);
    logger.step('====== Bot Selesai. ======');
}

runBot().catch(error => logger.error(`Eksekusi bot gagal total: ${error.message}`));
