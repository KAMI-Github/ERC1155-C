import { expect } from 'chai';
import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { parseUnits, ContractTransactionReceipt, Contract } from 'ethers';
import { KAMI1155C, MockERC20 } from '../typechain-types';

describe('KAMI1155C with USDC Payments', function () {
	let kami1155c: KAMI1155C;
	let usdc: MockERC20;
	let owner: SignerWithAddress;
	let user1: SignerWithAddress;
	let user2: SignerWithAddress;
	let platformAddress: SignerWithAddress;
	let royaltyReceiver1: SignerWithAddress;
	let royaltyReceiver2: SignerWithAddress;
	let royaltyReceiver3: SignerWithAddress;

	const MINT_PRICE = parseUnits('1', 6);
	const INITIAL_USDC_BALANCE = parseUnits('10000', 6);
	const PLATFORM_COMMISSION_PERCENTAGE = 500; // 5%
	const DEFAULT_ROYALTY_PERCENTAGE = 1000; // 10%
	const BASE_URI = 'https://api.example.com/token/';

	const createRoyaltyInfo = (address: string, feeNumerator: number) => {
		return {
			receiver: address,
			feeNumerator: feeNumerator,
		};
	};

	const getTokenIdFromMintReceipt = (receipt: ContractTransactionReceipt | null): bigint => {
		if (!receipt) throw new Error('No receipt found');
		for (const log of receipt.logs) {
			try {
				const parsedLog = kami1155c.interface.parseLog(log);
				if (parsedLog && parsedLog.name === 'TokenSold') {
					return parsedLog.args.id;
				}
			} catch (e) {
				// Ignore logs that don't match the ABI
			}
		}
		throw new Error('TokenSold event not found in mint transaction');
	};

	beforeEach(async function () {
		[owner, user1, user2, platformAddress, royaltyReceiver1, royaltyReceiver2, royaltyReceiver3] = await ethers.getSigners();

		const MockERC20Factory = await ethers.getContractFactory('contracts/MockERC20.sol:MockERC20');
		usdc = (await MockERC20Factory.deploy('USD Coin', 'USDC', 6)) as MockERC20;
		await usdc.waitForDeployment();

		await usdc.mint(user1.address, INITIAL_USDC_BALANCE);
		await usdc.mint(user2.address, INITIAL_USDC_BALANCE);

		const KAMI1155CFactory = await ethers.getContractFactory('KAMI1155C');
		kami1155c = (await KAMI1155CFactory.deploy(
			await usdc.getAddress(),
			BASE_URI,
			MINT_PRICE,
			platformAddress.address,
			PLATFORM_COMMISSION_PERCENTAGE
		)) as KAMI1155C;
		await kami1155c.waitForDeployment();

		await usdc.connect(user1).approve(await kami1155c.getAddress(), INITIAL_USDC_BALANCE);
		await usdc.connect(user2).approve(await kami1155c.getAddress(), INITIAL_USDC_BALANCE);
	});

	describe('Deployment', function () {
		it('Should set the right owner role', async function () {
			expect(await kami1155c.hasRole(await kami1155c.OWNER_ROLE(), owner.address)).to.be.true;
		});

		it('Should set the right platform role', async function () {
			expect(await kami1155c.hasRole(await kami1155c.PLATFORM_ROLE(), platformAddress.address)).to.be.true;
		});

		it('Should set the correct USDC token address', async function () {
			expect(await kami1155c.usdcToken()).to.equal(await usdc.getAddress());
		});

		it('Should set the correct mint price', async function () {
			expect(await kami1155c.mintPrice()).to.equal(MINT_PRICE);
		});

		it('Should set the correct platform commission percentage', async function () {
			expect(await kami1155c.platformCommissionPercentage()).to.equal(PLATFORM_COMMISSION_PERCENTAGE);
		});

		it('Should set the correct platform address', async function () {
			expect(await kami1155c.platformAddress()).to.equal(platformAddress.address);
		});

		it('Should implement ERC1155 functionality', async function () {
			const ERC1155InterfaceId = '0xd9b67a26';
			expect(await kami1155c.supportsInterface(ERC1155InterfaceId)).to.be.true;
		});

		it('Should set the base URI correctly', async function () {
			const tx = await kami1155c.connect(user1).mint();
			const receipt = await tx.wait();
			const tokenId1 = getTokenIdFromMintReceipt(receipt);
			expect(await kami1155c.uri(tokenId1)).to.equal(BASE_URI + tokenId1.toString());
		});
	});

	describe('Mint Price Distribution', function () {
		it('Should distribute mint price correctly with platform commission and royalties', async function () {
			const mintRoyalties = [createRoyaltyInfo(royaltyReceiver1.address, 6000), createRoyaltyInfo(royaltyReceiver2.address, 3500)];
			await kami1155c.connect(owner).setMintRoyalties(mintRoyalties);

			const platformBalanceBefore = await usdc.balanceOf(platformAddress.address);
			const r1BalanceBefore = await usdc.balanceOf(royaltyReceiver1.address);
			const r2BalanceBefore = await usdc.balanceOf(royaltyReceiver2.address);
			const contractBalanceBefore = await usdc.balanceOf(await kami1155c.getAddress());

			const tx = await kami1155c.connect(user1).mint();
			const receipt = await tx.wait();
			const tokenId1 = getTokenIdFromMintReceipt(receipt);
			expect(tokenId1).to.equal(1n);

			const platformCommission = (MINT_PRICE * BigInt(PLATFORM_COMMISSION_PERCENTAGE)) / BigInt(10000);
			const remainingAmount = MINT_PRICE - platformCommission;
			const royalty1Amount = (remainingAmount * BigInt(6000)) / BigInt(10000);
			const royalty2Amount = (remainingAmount * BigInt(3500)) / BigInt(10000);
			const totalRoyaltyAmounts = royalty1Amount + royalty2Amount;
			const undistributedAmount = remainingAmount - totalRoyaltyAmounts;

			expect(await usdc.balanceOf(platformAddress.address)).to.equal(platformBalanceBefore + platformCommission);
			expect(await usdc.balanceOf(royaltyReceiver1.address)).to.equal(r1BalanceBefore + royalty1Amount + undistributedAmount);
			expect(await usdc.balanceOf(royaltyReceiver2.address)).to.equal(r2BalanceBefore + royalty2Amount);
			expect(await usdc.balanceOf(await kami1155c.getAddress())).to.equal(contractBalanceBefore);

			expect(await kami1155c.balanceOf(user1.address, tokenId1)).to.equal(1);
		});

		it('Should ensure mint royalties plus platform commission cannot exceed 100%', async function () {
			const excessiveMintRoyalties = [
				createRoyaltyInfo(royaltyReceiver1.address, 6000),
				createRoyaltyInfo(royaltyReceiver2.address, 4000),
			];
			await expect(kami1155c.connect(owner).setMintRoyalties(excessiveMintRoyalties)).to.be.revertedWith(
				'Royalties + commission exceed 100%'
			);
		});
	});

	describe('Token Sale Process', function () {
		let tokenId1: bigint;
		beforeEach(async function () {
			const transferRoyalties = [
				createRoyaltyInfo(royaltyReceiver1.address, 7000),
				createRoyaltyInfo(royaltyReceiver2.address, 3000),
			];
			await kami1155c.connect(owner).setTransferRoyalties(transferRoyalties);
			await kami1155c.connect(owner).setRoyaltyPercentage(DEFAULT_ROYALTY_PERCENTAGE);

			const tx = await kami1155c.connect(user1).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
			expect(tokenId1).to.equal(1n);
		});

		it('Should correctly process a token sale with royalties and platform commission', async function () {
			const salePrice = parseUnits('1000', 6);
			const user1BalanceBefore = await usdc.balanceOf(user1.address);
			const user2BalanceBefore = await usdc.balanceOf(user2.address);
			const platformBalanceBefore = await usdc.balanceOf(platformAddress.address);
			const r1BalanceBefore = await usdc.balanceOf(royaltyReceiver1.address);
			const r2BalanceBefore = await usdc.balanceOf(royaltyReceiver2.address);

			await kami1155c.connect(user1).sellToken(user2.address, tokenId1, salePrice);

			const royaltyAmount = (salePrice * BigInt(DEFAULT_ROYALTY_PERCENTAGE)) / BigInt(10000);
			const platformCommission = (salePrice * BigInt(PLATFORM_COMMISSION_PERCENTAGE)) / BigInt(10000);
			const royalty1Amount = (royaltyAmount * BigInt(7000)) / BigInt(10000);
			const royalty2Amount = (royaltyAmount * BigInt(3000)) / BigInt(10000);
			const totalCalculatedRoyalty = royalty1Amount + royalty2Amount;
			const royaltyDust = royaltyAmount - totalCalculatedRoyalty;
			const sellerProceeds = salePrice - (royaltyAmount + platformCommission);

			expect(await kami1155c.balanceOf(user1.address, tokenId1)).to.equal(0);
			expect(await kami1155c.balanceOf(user2.address, tokenId1)).to.equal(1);

			expect(await usdc.balanceOf(platformAddress.address)).to.equal(platformBalanceBefore + platformCommission);
			expect(await usdc.balanceOf(royaltyReceiver1.address)).to.equal(r1BalanceBefore + royalty1Amount + royaltyDust);
			expect(await usdc.balanceOf(royaltyReceiver2.address)).to.equal(r2BalanceBefore + royalty2Amount);
			expect(await usdc.balanceOf(user1.address)).to.equal(user1BalanceBefore + sellerProceeds);
			expect(await usdc.balanceOf(user2.address)).to.equal(user2BalanceBefore - salePrice);
		});

		it('Should use token-specific royalty receivers if set', async function () {
			const tokenSpecificRoyalties = [
				createRoyaltyInfo(royaltyReceiver2.address, 8000),
				createRoyaltyInfo(royaltyReceiver3.address, 2000),
			];
			await kami1155c.connect(owner).setTokenTransferRoyalties(tokenId1, tokenSpecificRoyalties);

			const salePrice = parseUnits('1000', 6);
			const r1BalanceBefore = await usdc.balanceOf(royaltyReceiver1.address);
			const r2BalanceBefore = await usdc.balanceOf(royaltyReceiver2.address);
			const r3BalanceBefore = await usdc.balanceOf(royaltyReceiver3.address);

			await kami1155c.connect(user1).sellToken(user2.address, tokenId1, salePrice);

			const totalRoyaltyAmount = (salePrice * BigInt(DEFAULT_ROYALTY_PERCENTAGE)) / BigInt(10000);
			const royalty2Amount = (totalRoyaltyAmount * BigInt(8000)) / BigInt(10000);
			const royalty3Amount = (totalRoyaltyAmount * BigInt(2000)) / BigInt(10000);
			const totalCalculatedRoyalty = royalty2Amount + royalty3Amount;
			const royaltyDust = totalRoyaltyAmount - totalCalculatedRoyalty;

			expect(await usdc.balanceOf(royaltyReceiver1.address)).to.equal(r1BalanceBefore);
			expect(await usdc.balanceOf(royaltyReceiver2.address)).to.equal(r2BalanceBefore + royalty2Amount + royaltyDust);
			expect(await usdc.balanceOf(royaltyReceiver3.address)).to.equal(r3BalanceBefore + royalty3Amount);
		});

		it('Should only allow the token owner (caller) to sell', async function () {
			const salePrice = parseUnits('1000', 6);
			await expect(kami1155c.connect(user2).sellToken(royaltyReceiver1.address, tokenId1, salePrice)).to.be.revertedWith(
				'Seller does not own token ID'
			);
		});
	});

	describe('Platform Management', function () {
		it('Should allow updating platform commission and address', async function () {
			const newPlatformCommission = 800;
			const newPlatformAddress = royaltyReceiver3.address;

			await kami1155c.connect(owner).setPlatformCommission(newPlatformCommission, newPlatformAddress);

			expect(await kami1155c.platformCommissionPercentage()).to.equal(newPlatformCommission);
			expect(await kami1155c.platformAddress()).to.equal(newPlatformAddress);
			expect(await kami1155c.hasRole(await kami1155c.PLATFORM_ROLE(), platformAddress.address)).to.be.false;
			expect(await kami1155c.hasRole(await kami1155c.PLATFORM_ROLE(), newPlatformAddress)).to.be.true;
		});

		it('Should allow updating royalty percentage', async function () {
			const newRoyaltyPercentage = 1500;
			await kami1155c.connect(owner).setRoyaltyPercentage(newRoyaltyPercentage);
			expect(await kami1155c.royaltyPercentage()).to.equal(newRoyaltyPercentage);
		});

		it('Should not allow platform commission to exceed 20%', async function () {
			await expect(kami1155c.connect(owner).setPlatformCommission(2100, platformAddress.address)).to.be.revertedWith(
				'Platform commission too high'
			);
		});

		it('Should not allow royalty percentage to exceed 30%', async function () {
			await expect(kami1155c.connect(owner).setRoyaltyPercentage(3100)).to.be.revertedWith('Royalty percentage too high');
		});
	});

	describe('Transfer Royalties', function () {
		let tokenId1: bigint;
		beforeEach(async function () {
			const tx = await kami1155c.connect(user1).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
		});

		it('Should enforce 100% total for transfer royalty percentages', async function () {
			const lowRoyalties = [createRoyaltyInfo(royaltyReceiver1.address, 5000), createRoyaltyInfo(royaltyReceiver2.address, 3000)];
			await expect(kami1155c.connect(owner).setTransferRoyalties(lowRoyalties)).to.be.revertedWith(
				'Transfer royalties must equal 100%'
			);

			const highRoyalties = [createRoyaltyInfo(royaltyReceiver1.address, 7000), createRoyaltyInfo(royaltyReceiver2.address, 4000)];
			await expect(kami1155c.connect(owner).setTransferRoyalties(highRoyalties)).to.be.revertedWith(
				'Transfer royalties must equal 100%'
			);

			const perfectRoyalties = [createRoyaltyInfo(royaltyReceiver1.address, 7000), createRoyaltyInfo(royaltyReceiver2.address, 3000)];
			await kami1155c.connect(owner).setTransferRoyalties(perfectRoyalties);

			const royalties = await kami1155c.getTransferRoyaltyReceivers(tokenId1);
			expect(royalties.length).to.equal(2);
			expect(royalties[0].receiver).to.equal(royaltyReceiver1.address);
			expect(royalties[0].feeNumerator).to.equal(7000);
			expect(royalties[1].receiver).to.equal(royaltyReceiver2.address);
			expect(royalties[1].feeNumerator).to.equal(3000);
		});
	});

	describe('Rental Functionality', function () {
		let tokenId1: bigint;
		beforeEach(async function () {
			const tx = await kami1155c.connect(user1).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
		});

		it('Should allow renting a token', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);

			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);

			const user1BalanceBefore = await usdc.balanceOf(user1.address);
			const user2BalanceBefore = await usdc.balanceOf(user2.address);
			const platformBalanceBefore = await usdc.balanceOf(platformAddress.address);
			const contractBalanceBefore = await usdc.balanceOf(await kami1155c.getAddress());

			const latestBlock = await ethers.provider.getBlock('latest');
			if (!latestBlock) throw new Error('Failed to get latest block');
			const currentBlockTimestamp = latestBlock.timestamp;

			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			const rentalInfo = await kami1155c.getRentalInfo(tokenId1);
			expect(rentalInfo.owner).to.equal(user1.address);
			expect(rentalInfo.renter).to.equal(user2.address);
			expect(rentalInfo.startTime).to.be.closeTo(currentBlockTimestamp, 5);
			expect(rentalInfo.endTime).to.be.closeTo(currentBlockTimestamp + rentalDuration, 5);
			expect(rentalInfo.rentalPrice).to.equal(rentalPrice);
			expect(rentalInfo.active).to.be.true;
			expect(await kami1155c.isRented(tokenId1)).to.be.true;

			const platformCommission = (rentalPrice * BigInt(PLATFORM_COMMISSION_PERCENTAGE)) / BigInt(10000);
			const ownerShare = rentalPrice - platformCommission;

			expect(await usdc.balanceOf(user1.address)).to.equal(user1BalanceBefore + ownerShare);
			expect(await usdc.balanceOf(user2.address)).to.equal(user2BalanceBefore - rentalPrice);
			expect(await usdc.balanceOf(platformAddress.address)).to.equal(platformBalanceBefore + platformCommission);
			expect(await usdc.balanceOf(await kami1155c.getAddress())).to.equal(contractBalanceBefore);
			expect(await kami1155c.hasRole(await kami1155c.RENTER_ROLE(), user2.address)).to.be.true;
		});

		it('Should prevent renting an already rented token', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice * 2n);
			await usdc.connect(royaltyReceiver1).approve(await kami1155c.getAddress(), rentalPrice);

			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await expect(kami1155c.connect(royaltyReceiver1).rentToken(tokenId1, rentalDuration, rentalPrice)).to.be.revertedWith(
				'Token is actively rented'
			);
		});

		it('Should prevent the owner from renting their own token', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user1).approve(await kami1155c.getAddress(), rentalPrice);

			await expect(kami1155c.connect(user1).rentToken(tokenId1, rentalDuration, rentalPrice)).to.be.revertedWith('Owner cannot rent');
		});

		it('Should allow ending a rental early (by owner)', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await kami1155c.connect(user1).endRental(tokenId1);

			const rentalInfo = await kami1155c.getRentalInfo(tokenId1);
			expect(rentalInfo.active).to.be.false;
			expect(await kami1155c.isRented(tokenId1)).to.be.false;
			expect(await kami1155c.hasRole(await kami1155c.RENTER_ROLE(), user2.address)).to.be.false;
		});

		it('Should allow ending a rental early (by renter)', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await kami1155c.connect(user2).endRental(tokenId1);

			const rentalInfo = await kami1155c.getRentalInfo(tokenId1);
			expect(rentalInfo.active).to.be.false;
			expect(await kami1155c.isRented(tokenId1)).to.be.false;
			expect(await kami1155c.hasRole(await kami1155c.RENTER_ROLE(), user2.address)).to.be.false;
		});

		it('Should allow extending a rental', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			const additionalDuration = 43200;
			const additionalPayment = parseUnits('0.25', 6);

			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice + additionalPayment);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);
			const initialRentalInfo = await kami1155c.getRentalInfo(tokenId1);

			const user1BalanceBefore = await usdc.balanceOf(user1.address);
			const user2BalanceBefore = await usdc.balanceOf(user2.address);
			const platformBalanceBefore = await usdc.balanceOf(platformAddress.address);
			const contractBalanceBefore = await usdc.balanceOf(await kami1155c.getAddress());

			await kami1155c.connect(user2).extendRental(tokenId1, additionalDuration, additionalPayment);

			const rentalInfo = await kami1155c.getRentalInfo(tokenId1);
			expect(rentalInfo.endTime).to.equal(initialRentalInfo.endTime + BigInt(additionalDuration));
			expect(rentalInfo.rentalPrice).to.equal(rentalPrice + additionalPayment);
			expect(rentalInfo.active).to.be.true;

			const platformCommission = (additionalPayment * BigInt(PLATFORM_COMMISSION_PERCENTAGE)) / BigInt(10000);
			const ownerShare = additionalPayment - platformCommission;

			expect(await usdc.balanceOf(user1.address)).to.equal(user1BalanceBefore + ownerShare);
			expect(await usdc.balanceOf(user2.address)).to.equal(user2BalanceBefore - additionalPayment);
			expect(await usdc.balanceOf(platformAddress.address)).to.equal(platformBalanceBefore + platformCommission);
			expect(await usdc.balanceOf(await kami1155c.getAddress())).to.equal(contractBalanceBefore);
		});

		it('Should prevent selling during rental period', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			const salePrice = parseUnits('10', 6);
			await expect(kami1155c.connect(user1).sellToken(royaltyReceiver1.address, tokenId1, salePrice)).to.be.revertedWith(
				'Token is actively rented'
			);
		});

		it('Should prevent burning during rental period', async function () {
			const rentalDuration = 86400;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await expect(kami1155c.connect(user1).burn(tokenId1)).to.be.revertedWith('Token is actively rented');
		});

		it('Should allow selling after rental period expires', async function () {
			const rentalDuration = 5;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await ethers.provider.send('evm_increaseTime', [rentalDuration + 1]);
			await ethers.provider.send('evm_mine', []);

			expect(await kami1155c.isRented(tokenId1)).to.be.false;

			const salePrice = parseUnits('10', 6);
			await usdc.connect(royaltyReceiver1).mint(royaltyReceiver1.address, salePrice);
			await usdc.connect(royaltyReceiver1).approve(await kami1155c.getAddress(), salePrice);

			await expect(kami1155c.connect(user1).sellToken(royaltyReceiver1.address, tokenId1, salePrice)).to.not.be.reverted;

			expect(await kami1155c.balanceOf(user1.address, tokenId1)).to.equal(0);
			expect(await kami1155c.balanceOf(royaltyReceiver1.address, tokenId1)).to.equal(1);
		});

		it('Should allow burning after rental period expires', async function () {
			const rentalDuration = 5;
			const rentalPrice = parseUnits('0.5', 6);
			await usdc.connect(user2).approve(await kami1155c.getAddress(), rentalPrice);
			await kami1155c.connect(user2).rentToken(tokenId1, rentalDuration, rentalPrice);

			await ethers.provider.send('evm_increaseTime', [rentalDuration + 1]);
			await ethers.provider.send('evm_mine', []);

			expect(await kami1155c.isRented(tokenId1)).to.be.false;

			await expect(kami1155c.connect(user1).burn(tokenId1)).to.not.be.reverted;

			expect(await kami1155c.balanceOf(user1.address, tokenId1)).to.equal(0);
		});
	});
});
