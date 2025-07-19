import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { BuyYes, CreateMarket, Factory } from '../build/Factory/Factory_Factory';
import '@ton/test-utils';
import { BinaryMarket, BuyNo } from '../build/Factory/Factory_BinaryMarket';
import { sleep } from '@ton/blueprint';

describe('Factory', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let oracle: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let factory: SandboxContract<Factory>;

    // Helper functions    
    async function createTestMarket(question: string, probability = 50, closeTimestamp = Math.floor(Date.now() / 1000) + 86400): Promise<SandboxContract<BinaryMarket>> {
        const message: CreateMarket = {
            $$type: 'CreateMarket',
            question,
            clarification: 'sth',
            closeTimestamp: BigInt(closeTimestamp),
            oracleAddr: oracle.address,
            feeBps: BigInt(200),
            initialLiquidity: toNano('10'),
            initialProbability: BigInt(probability),
        };

        await factory.send(
            deployer.getSender(),
            { value: toNano('10.5') },
            message
        );

        const marketAddress = await factory.getGetMarketAddress(await factory.getGetNextMarketId() - 1n);
        return blockchain.openContract(BinaryMarket.fromAddress(marketAddress!));
    }

    async function buyShares(market: SandboxContract<BinaryMarket>, side: 'yes' | 'no', amount: bigint) {
        const message: BuyYes | BuyNo = side === 'yes'
            ? { $$type: 'BuyYes', amount }
            : { $$type: 'BuyNo', amount };

        await market.send(
            user.getSender(),
            { value: amount },
            message
        );
    }

    async function resolveMarket(market: SandboxContract<BinaryMarket>, outcome: boolean) {
        blockchain.now = Math.floor(Date.now() / 1000) + 86401;
        await market.send(
            oracle.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Resolve', outcome }
        );
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        factory = blockchain.openContract(await Factory.fromInit());

        deployer = await blockchain.treasury('deployer');
        oracle = await blockchain.treasury('oracle');
        user = await blockchain.treasury('user');

        // Deploy factory
        const deployResult = await factory.send(
            deployer.getSender(),
            { value: toNano('7'), bounce: true },
            null
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: factory.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy factory', async () => {
        // Already tested in beforeEach
    });

    it('should have correct initial state', async () => {
        expect(await factory.getGetNextMarketId()).toBe(0n);
        expect(await factory.getFactoryBalance()).toBeGreaterThan(0n);
    });

    it('should return null for non-existent market ID', async () => {
        expect(await factory.getGetMarketAddress(999n)).toBeNull();
    });

    it('should create a new market', async () => {
        const createMarketParams = {
            question: "Will TON reach $10 by 2025?",
            closeTimestamp: Math.floor(Date.now() / 1000) + 86400, // 1 day from now
            oracleAddr: oracle.address,
            feeBps: 200, // 2%
            initialLiquidity: toNano('5'), // 5 TON
            initialProbability: 60, // 60%
        };

        const createMarketMessage: CreateMarket = {
            $$type: 'CreateMarket',
            question: createMarketParams.question,
            clarification: 'make it clear! u...!',
            closeTimestamp: BigInt(createMarketParams.closeTimestamp),
            oracleAddr: createMarketParams.oracleAddr,
            feeBps: BigInt(createMarketParams.feeBps),
            initialLiquidity: createMarketParams.initialLiquidity,
            initialProbability: BigInt(createMarketParams.initialProbability),
        };

        const nextMarketId = await factory.getGetNextMarketId();
        const createResult = await factory.send(
            deployer.getSender(),
            {
                value: toNano('5.5'), // Initial liquidity + gas
            },
            createMarketMessage
        );

        expect(createResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: factory.address,
            success: true // Verify factory received message
        });

        // Verify market deployment transaction
        expect(createResult.transactions).toHaveTransaction({
            from: factory.address,
            deploy: true,
            success: true,
        });

        // Check factory state updated
        expect(await factory.getGetNextMarketId()).toBe(nextMarketId + 1n);
        expect(await factory.getGetMarketAddress(nextMarketId)).toBeDefined();

        // Get market address and open contract
        const marketAddress = await factory.getGetMarketAddress(nextMarketId);
        const market = blockchain.openContract(
            BinaryMarket.fromAddress(marketAddress!)
        );

        // Verify market initialization
        const marketState = await market.getGetMarketState();
        expect(marketState.question).toEqual(createMarketParams.question);
        expect(marketState.oracleAddr.equals(oracle.address)).toBe(true);
        expect(marketState.feeBps).toEqual(BigInt(createMarketParams.feeBps));
        expect(marketState.closeTimestamp).toEqual(BigInt(createMarketParams.closeTimestamp));
        expect(marketState.factory.equals(factory.address)).toBe(true);
        expect(marketState.marketId).toEqual(nextMarketId);
    });

    it('should fail with insufficient liquidity', async () => {
        const createMarketMessage: CreateMarket = {
            $$type: 'CreateMarket',
            question: "Test Market",
            clarification: 'as if it is not clear',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
            oracleAddr: oracle.address,
            feeBps: BigInt(200),
            initialLiquidity: toNano('0.09'), // < 0.1 TON
            initialProbability: BigInt(50),
        };

        const nextMarketId = await factory.getGetNextMarketId();

        const result = await factory.send(
            deployer.getSender(),
            {
                value: toNano('1.4'), // init liquidity 0.9 + 0.5 gas fee
                bounce: true
            },
            createMarketMessage
        );

        // Should have failed
        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: factory.address,
            success: false,
            exitCode: 15876,
        });

        // Verify no state changes occurred
        expect(await factory.getGetNextMarketId()).toEqual(nextMarketId);
    });

    it('should fail with invalid probability', async () => {
        const createMarketMessage: CreateMarket = {
            $$type: 'CreateMarket',
            question: "Test Market",
            clarification: 'yep all clear',
            closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
            oracleAddr: oracle.address,
            feeBps: BigInt(200),
            initialLiquidity: toNano('10'),
            initialProbability: BigInt(0), // Invalid probability
        };

        const result = await factory.send(
            deployer.getSender(),
            {
                value: toNano('10.1'),
                bounce: true
            },
            createMarketMessage
        );

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: factory.address,
            success: false,
            exitCode: 12925
        });
    });

    it('should return correct next market ID', async () => {
        const initialId = await factory.getGetNextMarketId(); // 0n

        await createTestMarket("Market 1");
        expect(await factory.getGetNextMarketId()).toBe(initialId + 1n);

        await createTestMarket("Market 2");
        expect(await factory.getGetNextMarketId()).toBe(initialId + 2n);
    });

    it('should reflect correct factory balance', async () => {
        const initialBalance = await factory.getFactoryBalance();
        await createTestMarket("Balance Test");
        const newBalance = await factory.getFactoryBalance();

        // Balance should decrease by deployment cost
        expect(newBalance - toNano('10.5')).toBeLessThan(initialBalance);
    });

    it('should initialize with correct probability distribution', async () => {
        await createTestMarket("Prob Test", 30); // 30% probability
        const marketAddress = await factory.getGetMarketAddress(0n);
        const market = blockchain.openContract(
            BinaryMarket.fromAddress(marketAddress!)
        );
        const state = await market.getGetMarketState();

        // Verify initial reserves match probability
        const total = state.reserveYes + state.reserveNo;
        const expectedYes = (total * 30n) / 100n;
        expect(Number(state.reserveYes)).toBeCloseTo(Number(expectedYes), Number(1n)); // Allow small rounding
    });

    describe('BuyYes functionality', () => {
        it('should correctly update reserves and balances', async () => {
            const market = await createTestMarket("Buy Test");
            const initialState = await market.getGetMarketState();

            const buyAmount = toNano('5');
            await market.send(
                user.getSender(),
                { value: buyAmount },
                { $$type: 'BuyYes', amount: buyAmount }
            );

            const newState = await market.getGetMarketState();
            expect(newState.reserveNo).toBeGreaterThan(initialState.reserveNo);
            expect(newState.reserveYes).toBeLessThan(initialState.reserveYes);

            const userBalances = await market.getGetUserBalances(user.address);
            expect(userBalances.yes).toBeGreaterThan(0n);
        });
    });

    describe('BuyNo functionality', () => {
        it('should correctly update reserves and balances', async () => {
            const market = await createTestMarket("Buy Test");
            const initialState = await market.getGetMarketState();

            const buyAmount = toNano('5');
            await market.send(
                user.getSender(),
                { value: buyAmount },
                { $$type: 'BuyNo', amount: buyAmount }
            );

            const newState = await market.getGetMarketState();
            expect(newState.reserveNo).toBeLessThan(initialState.reserveNo);
            expect(newState.reserveYes).toBeGreaterThan(initialState.reserveYes);

            const userBalances = await market.getGetUserBalances(user.address);
            expect(userBalances.no).toBeGreaterThan(0n);
        });
    });

    describe('SellYes functionality', () => {
        it('should fail with insufficient shares', async () => {
            const market = await createTestMarket("Sell Test");

            const result = await market.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SellYes', amount: toNano('1') }
            );

            expect(result.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 60955
            });
        });

        it('should correctly process sale and send TON', async () => {
            const market = await createTestMarket("Sell Test");
            await buyShares(market, 'yes', toNano('5'));

            const initialBalance: BigInt = await user.getBalance();
            await market.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SellYes', amount: toNano('1') }
            );

            const newBalance = await user.getBalance();
            expect(Number(newBalance)).toBeGreaterThan(Number(initialBalance));
        });
    });

    describe('SellNo functionality', () => {
        it('should fail with insufficient shares', async () => {
            const market = await createTestMarket("Sell Test");

            const result = await market.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SellNo', amount: toNano('1') }
            );

            expect(result.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 63761
            });
        });

        it('should correctly process sale and send TON', async () => {
            const market = await createTestMarket("Sell Test");
            await buyShares(market, 'no', toNano('5'));

            const initialBalance: BigInt = await user.getBalance();
            await market.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'SellNo', amount: toNano('1') }
            );

            const newBalance = await user.getBalance();
            expect(Number(newBalance)).toBeGreaterThan(Number(initialBalance));
        });
    });

    describe('Market Resolution', () => {
        it('should fail when called by non-oracle', async () => {
            const market = await createTestMarket("Resolution Test");

            const result = await market.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'Resolve', outcome: true }
            );

            expect(result.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 49729
            });
        });

        it('should correctly distribute winnings for YES outcome', async () => {
            const market = await createTestMarket("Winnings Test");
            await buyShares(market, 'yes', toNano('5'));

            const initialBalance = await user.getBalance();
            await market.send(
                oracle.getSender(),
                { value: toNano('0.1') },
                { $$type: 'Resolve', outcome: true }
            );

            const newBalance = await user.getBalance();
            expect(newBalance).toBeGreaterThanOrEqual(initialBalance);
        });
    });

    describe('Price Calculations', () => {
        it('should return correct YES price', async () => {
            const market = await createTestMarket("Price Test", 30); // 30% initial
            const price = await market.getGetPriceYes();
            console.log('YES PRICE: MARKET STATE: ', await market.getGetMarketState());
            expect(Number(price)).toBeCloseTo(23333, 100); // ~30% ...
            // quite struggled with this one... here's the math:
            // (7_000_000_000 * 10_000) / 3_000_000_000 = 70_000_000_000 / 3_000_000_000 = 23.333... ≈ 23333
            // corresponds to a YES price of ~0.23333 TON (or 23.33% probability)
        });

        it('should update prices after trades', async () => {
            const market = await createTestMarket("Price Test");
            const initialPrice = await market.getGetPriceYes();

            await buyShares(market, 'yes', toNano('5'));
            const newPrice = await market.getGetPriceYes();

            expect(newPrice).toBeGreaterThan(initialPrice);
        });
    });

    // እጅ ክዝ (edge case tests)
    describe('Edge Cases', () => {
        it('should handle minimum liquidity correctly', async () => {
            const message: CreateMarket = {
                $$type: 'CreateMarket',
                question: "Min Liquidity",
                clarification: 'what am I doing with my life',
                closeTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
                oracleAddr: oracle.address,
                feeBps: BigInt(200),
                initialLiquidity: toNano('1'), // Exactly minimum
                initialProbability: BigInt(50),
            };

            const result = await factory.send(
                deployer.getSender(),
                { value: toNano('1.5') },
                message
            );

            expect(result.transactions).toHaveTransaction({
                from: factory.address,
                deploy: true,
                success: true
            });
        });

        it('should prevent trading after close', async () => {
            const market = await createTestMarket("Timing Test");
            // Fast-forward blockchain time
            blockchain.now = Math.floor(Date.now() / 1000) + 86401;

            const result = await market.send(
                user.getSender(),
                { value: toNano('5') },
                { $$type: 'BuyYes', amount: toNano('1') }
            );

            expect(result.transactions).toHaveTransaction({
                to: market.address,
                success: false,
                exitCode: 12336
            });
        });
    });
});
