import { toNano } from '@ton/core';
import { Factory } from '../build/Factory/Factory_Factory';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const factory = provider.open(await Factory.fromInit());

    await factory.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        null,
    );

    await provider.waitForDeploy(factory.address);

    // run methods on `factory`
}
