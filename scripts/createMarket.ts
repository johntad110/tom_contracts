import { Address, address, toNano } from '@ton/core';
import { CreateMarket, Factory } from '../build/Factory/Factory_Factory';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const factory = provider.open(Factory.fromAddress(Address.parse('kQCtTa5Tlw7W2qflcdR8lN31KPzluJQA31mCsrfB0CgNuuJp')));
    const oracleAddr = address('0QCslVT9iwKH58_5XgEd7wyJjHirNIqxIJAqxIAonlHD8tEF');

    const markets: CreateMarket[] = [
        {
            $$type: 'CreateMarket',
            question: 'Will TON price reach $8.50 on Binance by Friday?',
            clarification: 'Resolution based on Binance TON/USDT closing price at 23:59:59 UTC on Friday. Must reach exactly or exceed $8.50. API data from Binance official feed will be used.',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 3),
            oracleAddr: oracleAddr,
            feeBps: BigInt(200),
            initialLiquidity: toNano("0.1"),
            initialProbability: BigInt(35),
        },
        {
            $$type: 'CreateMarket',
            question: 'Will The Open Hack 2025 submission exceed 100 teams?',
            clarification: 'Counted by unique project submissions on the official AKINDO website. Must be >100 before Phase 2 deadline. Includes only completed submissions.',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 5),
            oracleAddr: oracleAddr,
            feeBps: BigInt(200),
            initialLiquidity: toNano("0.1"),
            initialProbability: BigInt(60),
        },
        {
            $$type: 'CreateMarket',
            question: 'Will TON blockchain daily transactions exceed 5M this week?',
            clarification: 'Any 24h period between now and close time counts. Based on official TON blockchain stats (tontech.io). Transactions include all message types.',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
            oracleAddr: oracleAddr,
            feeBps: BigInt(200),
            initialLiquidity: toNano("0.1"),
            initialProbability: BigInt(45),
        },
        {
            $$type: 'CreateMarket',
            question: 'Will Telegram announce new TON integration this week?',
            clarification: 'Official announcement via Telegram blog/news channel. Must be verifiable technical integration (not just mentions). Excludes minor UI updates.',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 4),
            oracleAddr: oracleAddr,
            feeBps: BigInt(200),
            initialLiquidity: toNano("0.1"),
            initialProbability: BigInt(25),
        },
        {
            $$type: 'CreateMarket',
            question: 'Will any Tap-to-Earn game on TON hit 1M DAU this week?',
            clarification: 'DAU = Unique wallet addresses interacting with game contract. Must be sustained for 24h. Based on game\'s official stats or verifiable chain data.',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
            oracleAddr: oracleAddr,
            feeBps: BigInt(200),
            initialLiquidity: toNano("0.1"),
            initialProbability: BigInt(30),
        }
    ];

    for (const message of markets) {
        const nextMarketIDBefore = await factory.getGetNextMarketId();

        await factory.send(
            provider.sender(),
            {
                value: toNano('0.2'),
                bounce: true,
            },
            message,
        );

        let nextMarketID = nextMarketIDBefore;
        const startTime = Date.now();
        let tries = 0;
        while (nextMarketID == nextMarketIDBefore && Date.now() - startTime < 30000) {
            console.log(`${tries}. Waiting for market "${message.question}" to be deployed...`)
            await sleep(1500);
            nextMarketID = await factory.getGetNextMarketId();
            tries += 1;
        }

        if (nextMarketID != nextMarketIDBefore) {
            console.log(`Market "${message.question}" deployed successfully. New Market ID: ${nextMarketID}`);
        } else {
            console.error(`Timeout waiting for market creation: "${message.question}"`);
        }
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}