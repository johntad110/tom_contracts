import "@stdlib/deploy";

// አንዳንድ ቋሚዎች (some constants)
const MIN_LIQUIDITY: Int = ton("0.1");
const FEE_DENOMINATOR: Int = 10000;
const OWNER: Address = address("0QCslVT9iwKH58_5XgEd7wyJjHirNIqxIJAqxIAonlHD8tEF");

struct MarketInit {
    factory: Address;
    marketId: Int as uint64;
}

message(0x481337e6) CreateMarket {
    question: String;
    clarification: String;
    closeTimestamp: Int as uint64;
    oracleAddr: Address;
    feeBps: Int as uint16;
    initialLiquidity: Int as coins;
    initialProbability: Int as uint8;
}
message(0xba69751) Withdraw {
    amount: Int as coins;
}

contract Factory {
    nextMarketId: Int as uint64 = 0;

    receive() {}

    receive(msg: CreateMarket) {
        require(msg.initialLiquidity >= MIN_LIQUIDITY, "Min liquidity .1 TON");
        require(msg.initialProbability > 0 && msg.initialProbability < 100, "Invalid probability");
        require(msg.closeTimestamp > now(), "can't travel back in time");
        require(context().value >= msg.initialLiquidity + ton("0.1"), "Send atleast .1 TON + initial liquidity");

        let marketId = self.nextMarketId;
        self.nextMarketId += 1;

        let marketInit = initOf BinaryMarket(MarketInit {
            factory: myAddress(),
            marketId,
        });

        let setup = CreateMarket {
            question: msg.question,
            clarification: msg.clarification,
            closeTimestamp: msg.closeTimestamp,
            oracleAddr: msg.oracleAddr,
            feeBps: msg.feeBps,
            initialLiquidity: msg.initialLiquidity,
            initialProbability: msg.initialProbability,
        };

        deploy(DeployParameters {
            init: marketInit,
            mode: SendPayFwdFeesSeparately,
            value: msg.initialLiquidity,
            body: setup.toCell(),
        });
    }

    receive(msg: Withdraw) {
        require(sender() == OWNER, "Only owner can withdraw");
        require(myBalance() > msg.amount, "Withdraw amount must to be strictly less than balance");

        message(MessageParameters {
            to: OWNER,
            value: msg.amount,
            bounce: true,
            mode: SendPayFwdFeesSeparately,
        });
    }

    get fun getMarketAddress(marketId: Int): Address? {
        if (marketId >= self.nextMarketId) { return null }
        return contractAddress(initOf BinaryMarket(MarketInit { factory: myAddress(), marketId }));
    }

    get fun getNextMarketId(): Int {
        return self.nextMarketId;
    }

    get fun factoryBalance(): Int {
        return myBalance();
    }

    // Factory Admin Functions
    // To-Do: implement these
    // fun setMinLiquidity(amount: Int) {} // Sets hte global minimum liquidity for new markets
    // fun setOwner(address: Address) {} // Sets contract owner (just incase  needed for govenance or fee claiming)
}

struct MarketState {
    reserveYes: Int as coins;
    reserveNo: Int as coins;
    k: Int as coins; // Constant product (reserveYes * reserveNo)
    feeBps: Int as uint16;
    oracleAddr: Address;
    closeTimestamp: Int as uint64;
    resolved: Bool;
    outcome: Bool?; // true = YES, false = NO
    factory: Address;
    marketId: Int as uint64;
    question: String;
}

struct YesNoBalances {
    yes: Int?;
    no: Int?;
}

message(0x1674727b) BuyYes {
    amount: Int as coins;
}
message(0x4d689170) BuyNo {
    amount: Int as coins;
}
message(0x7aab1b57) SellYes {
    amount: Int as coins;
}
message(0x1ebcd0dd) SellNo {
    amount: Int as coins;
}
message(0xef42713d) Resolve {
    outcome: Bool;
}
message(0xcf090942) Redeem {
    addr: Address;
}

// Handles market state, trades, share balances, resolution, and redemption
contract BinaryMarket {
    reserveYes: Int as coins = 0;
    reserveNo: Int as coins = 0;
    k: Int as coins = 0; // Constant product
    feeBps: Int as uint16 = 0;
    oracleAddr: Address;
    closeTimestamp: Int as uint64 = 0;
    resolved: Bool = false;
    outcome: Bool? = null;
    factory: Address;
    marketId: Int as uint64 = 0;
    question: String = "";
    clarification: String = "";

    yesBalances: map<Address, Int as coins> = emptyMap();
    noBalances: map<Address, Int as coins> = emptyMap();

    winningTotalSupply: Int as uint64 = 0;
    winningPayoutPool: Int as uint64 = 0;

    init(data: MarketInit) {
        require(data.factory == sender(), "Unauthorized deployment");
        self.factory = data.factory;
        self.marketId = data.marketId;
        self.oracleAddr = sender();
    }

    receive(setup: CreateMarket) {
        // init() is implicitly called here, so we know it is called by factory
        // CreateMarket can be called only once in this contract: it is guaranteed by the factory contract
        self.question = setup.question;
        self.clarification = setup.clarification;
        self.closeTimestamp = setup.closeTimestamp;
        self.oracleAddr = setup.oracleAddr;
        self.feeBps = setup.feeBps;

        // Initialize reserves based on initial probability
        let initialYes = (setup.initialLiquidity * setup.initialProbability) / 100;
        let initialNo = setup.initialLiquidity - initialYes;

        self.reserveYes = initialYes;
        self.reserveNo = initialNo;
        self.k = initialYes * initialNo;
    }

    receive(msg: BuyYes) {
        require(!self.resolved, "Market resolved");
        require(now() < self.closeTimestamp, "Market closed");
        require(msg.amount > 0, "Invalid amount");
        require(context().value >= msg.amount, "Inssuficient TON");

        // Calculate amount after fee
        let fee = (msg.amount * self.feeBps) / FEE_DENOMINATOR;
        let amountIn = msg.amount - fee;

        // Calculate YES tokens to mint
        let newReserveNo = self.reserveNo + amountIn;
        let newReserveYes = self.k / newReserveNo;
        let deltaYes = self.reserveYes - newReserveYes;

        // Update state
        self.reserveYes = newReserveYes;
        self.reserveNo = newReserveNo;
        self.k = self.reserveYes * self.reserveNo;

        // Mint YES tokens to sender
        let userBalance: Int? = self.yesBalances.get(sender());
        if (userBalance == null) { userBalance = 0 }
        self.yesBalances.set(sender(), userBalance!! + deltaYes);
    }

    receive(msg: BuyNo) {
        require(!self.resolved, "Market resolved");
        require(now() < self.closeTimestamp, "Market closed");
        require(msg.amount > 0, "Invalid amount");
        require(context().value >= msg.amount, "Inssuficient TON");

        // Calculate amount after fee
        let fee = (msg.amount * self.feeBps) / FEE_DENOMINATOR;
        let amountIn = msg.amount - fee;

        // Calculate NO tokens to mint
        let newReserveYes = self.reserveYes + amountIn;
        let newReserveNo = self.k / newReserveYes;
        let deltaNo = self.reserveNo - newReserveNo;

        // Update state
        self.reserveYes = newReserveYes;
        self.reserveNo = newReserveNo;
        self.k = self.reserveYes * self.reserveNo;

        // Mint NO tokens to sender
        let userBalance: Int? = self.noBalances.get(sender());
        if (userBalance == null) { userBalance = 0 }
        self.noBalances.set(sender(), userBalance!! + deltaNo);
    }

    receive(msg: SellYes) {
        require(!self.resolved, "Market resolved");
        require(now() < self.closeTimestamp, "Market closed");

        let senderAddr = sender();
        let userBal = self.yesBalances.get(senderAddr);
        require(userBal != null, "No Yes shares to sell");
        require(msg.amount > 0 && msg.amount <= userBal!!, "Invalid amount");

        // Apply AMM math
        let newReserveYes = self.reserveYes + msg.amount;
        let newReserveNo = self.k / newReserveYes;
        let deltaNo = self.reserveNo - newReserveNo;

        // Fee
        let fee = (deltaNo * self.feeBps) / FEE_DENOMINATOR;
        let payout = deltaNo - fee;

        // Update state
        self.reserveYes = newReserveYes;
        self.reserveNo = newReserveNo;
        self.k = self.reserveYes * self.reserveNo;

        // Burn YES tokens
        self.yesBalances.set(senderAddr, userBal!! - msg.amount);

        //Finally ... Transfer TON to user (`message` is more efficient than `send`)
        message(MessageParameters {
            to: senderAddr,
            bounce: true,
            value: payout,
            mode: SendPayFwdFeesSeparately,
        });
    }

    receive(msg: SellNo) {
        require(!self.resolved, "Market resolved");
        require(now() < self.closeTimestamp, "Market closed");

        let senderAddr = sender();
        let userBal = self.noBalances.get(senderAddr);
        require(userBal != null, "No NO shares to sell");
        require(msg.amount > 0 && msg.amount <= userBal!!, "Invalid amount");

        // Apply AMM math
        let newReserveNo = self.reserveNo + msg.amount;
        let newReserveYes = self.k / newReserveNo;
        let deltaYes = self.reserveYes - newReserveYes;

        // Fee
        let fee = (deltaYes * self.feeBps) / FEE_DENOMINATOR;
        let payout = deltaYes - fee;

        // Update state
        self.reserveNo = newReserveNo;
        self.reserveYes = newReserveYes;
        self.k = self.reserveYes * self.reserveNo;

        // Burn NO tokens
        self.noBalances.set(senderAddr, userBal!! - msg.amount);

        // Transfer TON to user
        message(MessageParameters {
            to: senderAddr,
            bounce: true,
            value: payout,
            mode: SendPayFwdFeesSeparately,
        });
    }

    // For MVP this resolve function immediately loops through all
    // holders and distributes their TON winnings based on the outcome.
    // But in future verion we'll wither switch to the Redeem function
    // or make a `claimAll()` to do back redemtion. The redeem pattern
    // is good for scalability.
    receive(msg: Resolve) {
        require(sender() == self.oracleAddr, "Unauthorized");
        require(now() >= self.closeTimestamp, "Too early");
        require(!self.resolved, "Already resolved");

        self.resolved = true;
        self.outcome = msg.outcome;

        if (msg.outcome) {
            let totalYes = 0;
            foreach (addr, bal in self.yesBalances) {
                totalYes += bal;
            }

            require(totalYes > 0, "No YES shares");

            foreach (addr, bal in self.yesBalances) {
                if (bal > 0) {
                    let payout = (self.reserveYes * bal) / totalYes;

                    self.yesBalances.set(addr, 0);
                    message(MessageParameters {
                        to: addr,
                        bounce: true,
                        value: payout,
                    });
                }
            }
        } else {
            let totalNo = 0;
            foreach (addr, bal in self.noBalances) {
                totalNo += bal;
            }

            require(totalNo > 0, "No NO shares");

            foreach (addr, bal in self.noBalances) {
                if (bal > 0) {
                    let payout = (self.reserveNo * bal) / totalNo;

                    self.noBalances.set(addr, 0); // Burn
                    message(MessageParameters {
                        to: addr,
                        bounce: true,
                        value: payout,
                        mode: SendPayFwdFeesSeparately,
                    });
                }
            }
        }

        // reset pool
        self.reserveYes = 0;
        self.reserveNo = 0;
        self.k = 0;
    }

    // Note: to use this `redeem` func the resovle function must first compute and
    // set the `totalWinningSupply` and the `winningPayoutPool`
    receive(msg: Redeem) {
        require(self.resolved, "Not resolved");

        let senderAddr = sender();
        if (self.outcome!!) {
            // YES wins
            let userBalance = self.yesBalances.get(senderAddr);
            require(userBalance != null && userBalance!! > 0, "No winning tokens");

            let payout = (self.winningPayoutPool * userBalance!!) / self.winningTotalSupply;

            // Burn YES shares
            self.yesBalances.set(senderAddr, 0);

            // Send payout
            message(MessageParameters {
                to: senderAddr,
                bounce: true,
                value: payout,
            });
        } else {
            // NO wins
            let userBalance = self.noBalances.get(senderAddr);
            require(userBalance != null && userBalance!! > 0, "No winning tokens");

            let payout = (self.winningPayoutPool * userBalance!!) / self.winningTotalSupply;

            // Burn NO shares
            self.noBalances.set(senderAddr, 0);

            // Send payout
            message(MessageParameters {
                to: senderAddr,
                bounce: true,
                value: payout,
            });
        }
    }

    receive(msg: Withdraw) {
        require(sender() == OWNER, "Only owner can withdraw");
        require(myBalance() > msg.amount, "Withdraw amount must to be strictly less than balance");

        message(MessageParameters {
            to: OWNER,
            value: msg.amount,
            bounce: true,
            mode: SendPayFwdFeesSeparately,
        });
    }

    // the proportion of YES in total liquidity (same 4 no)
    get fun yesProportion(): Int {
        return (self.reserveYes * 10000) / (self.reserveYes + self.reserveNo);
    }

    get fun noPropotion(): Int {
        return (self.reserveNo * 10000) / (self.reserveYes + self.reserveNo);
    }

    get fun getPriceYes(): Int {
        return (self.reserveNo * 10000) / self.reserveYes;
    }

    get fun getPriceNo(): Int {
        return (self.reserveYes * 10000) / self.reserveNo;
    }

    get fun getMarketState(): MarketState {
        return MarketState {
            reserveYes: self.reserveYes,
            reserveNo: self.reserveNo,
            k: self.k,
            feeBps: self.feeBps,
            oracleAddr: self.oracleAddr,
            closeTimestamp: self.closeTimestamp,
            resolved: self.resolved,
            outcome: self.outcome,
            factory: self.factory,
            marketId: self.marketId,
            question: self.question,
        };
    }

    get fun getUserBalances(addr: Address): YesNoBalances {
        return YesNoBalances {
            yes: self.yesBalances.get(addr),
            no: self.noBalances.get(addr),
        };
    }

    get fun marketBalance(): Int {
        return myBalance();
    }
}
