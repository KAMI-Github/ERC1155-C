import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { Contract, ContractTransactionReceipt } from 'ethers';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { MockERC20, ProxyAdmin } from '../typechain-types';
import { KAMI1155CUpgradeable } from '../typechain-types';

describe('KAMI1155CUpgradeable', function () {
	let contract: KAMI1155CUpgradeable;
	let proxyAdmin: ProxyAdmin;
	let mockUSDC: MockERC20;
	let owner: HardhatEthersSigner;
	let platform: HardhatEthersSigner;
	let buyer: HardhatEthersSigner;
	let royaltyReceiver: HardhatEthersSigner;
	let upgrader: HardhatEthersSigner;

	const BASE_URI = 'https://api.kami.example/metadata/';
	const MINT_PRICE = ethers.parseUnits('100', 6); // 100 USDC
	const PLATFORM_COMMISSION = 500; // 5%

	// Helper to get the token ID from the mint event (same as KAMI1155C tests)
	const getTokenIdFromMintReceipt = (receipt: ContractTransactionReceipt | null): bigint => {
		if (!receipt) throw new Error('No receipt found');
		for (const log of receipt.logs) {
			try {
				const parsedLog = contract.interface.parseLog(log);
				if (parsedLog && parsedLog.name === 'TokenSold') {
					// Mint emits TokenSold now
					return parsedLog.args.id;
				}
			} catch (e) {
				// Ignore logs that don't match the ABI
			}
		}
		throw new Error('TokenSold event not found in mint transaction');
	};

	beforeEach(async function () {
		[owner, platform, buyer, royaltyReceiver, upgrader] = await ethers.getSigners();

		const MockERC20Factory = await ethers.getContractFactory('contracts/test/MockERC20.sol:MockERC20');
		mockUSDC = (await MockERC20Factory.deploy('USD Coin', 'USDC', 6)) as MockERC20;
		await mockUSDC.waitForDeployment();
		await mockUSDC.mint(buyer.address, ethers.parseUnits('1000', 6));

		const KAMI1155CUpgradeableFactory = await ethers.getContractFactory('KAMI1155CUpgradeable');

		const contractInstance = await upgrades.deployProxy(
			KAMI1155CUpgradeableFactory,
			[await mockUSDC.getAddress(), BASE_URI, MINT_PRICE, platform.address, PLATFORM_COMMISSION],
			{
				initializer: 'initialize',
				kind: 'transparent',
			}
		);
		await contractInstance.waitForDeployment();

		contract = contractInstance as KAMI1155CUpgradeable;

		const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(await contract.getAddress());
		proxyAdmin = (await ethers.getContractAt('ProxyAdmin', proxyAdminAddress)) as ProxyAdmin;

		await mockUSDC.connect(buyer).approve(await contract.getAddress(), ethers.parseUnits('1000', 6));
	});

	describe('Initialization', function () {
		it('should initialize with correct values', async function () {
			// expect(await contract.name()).to.equal(NAME); // Removed
			// expect(await contract.symbol()).to.equal(SYMBOL); // Removed
			// expect(await contract.uri(1)).to.equal(BASE_URI + '1'); // Check URI instead of name/symbol
			expect(await contract.mintPrice()).to.equal(MINT_PRICE);
			expect(await contract.platformAddress()).to.equal(platform.address);
			expect(await contract.platformCommissionPercentage()).to.equal(PLATFORM_COMMISSION);
			expect(await contract.royaltyPercentage()).to.equal(1000); // Default 10%
		});

		it('should assign roles correctly', async function () {
			const OWNER_ROLE = await contract.OWNER_ROLE();
			const PLATFORM_ROLE = await contract.PLATFORM_ROLE();
			const UPGRADER_ROLE = await contract.UPGRADER_ROLE();

			expect(await contract.hasRole(OWNER_ROLE, owner.address)).to.be.true;
			expect(await contract.hasRole(PLATFORM_ROLE, platform.address)).to.be.true;
			expect(await contract.hasRole(UPGRADER_ROLE, owner.address)).to.be.true;
		});

		it('should not be able to initialize again', async function () {
			await expect(
				contract.initialize(await mockUSDC.getAddress(), BASE_URI, MINT_PRICE, platform.address, PLATFORM_COMMISSION)
			).to.be.revertedWith('Initializable: contract is already initialized');
		});
	});

	describe('Basic Functionality', function () {
		let tokenId1: bigint;

		beforeEach(async function () {
			const mintRoyaltyData = [{ receiver: royaltyReceiver.address, feeNumerator: 9500 }];
			const transferRoyaltyData = [{ receiver: royaltyReceiver.address, feeNumerator: 10000 }];
			await contract.setMintRoyalties(mintRoyaltyData);
			await contract.setTransferRoyalties(transferRoyaltyData);
		});

		it('should mint a token and check balance', async function () {
			const initialUSDCBalance = await mockUSDC.balanceOf(buyer.address);
			const initialPlatformBalance = await mockUSDC.balanceOf(platform.address);
			const initialRoyaltyReceiverBalance = await mockUSDC.balanceOf(royaltyReceiver.address);

			const tx = await contract.connect(buyer).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);

			// Check token balance
			expect(await contract.balanceOf(buyer.address, tokenId1)).to.equal(1);

			const platformCommission = (MINT_PRICE * BigInt(PLATFORM_COMMISSION)) / 10000n;
			const remainingAmount = MINT_PRICE - platformCommission;
			const royaltyAmount = (remainingAmount * 9500n) / 10000n;
			const undistributedAmount = remainingAmount - royaltyAmount;

			expect(await mockUSDC.balanceOf(buyer.address)).to.equal(initialUSDCBalance - MINT_PRICE);
			expect(await mockUSDC.balanceOf(platform.address)).to.equal(initialPlatformBalance + platformCommission);
			expect(await mockUSDC.balanceOf(royaltyReceiver.address)).to.equal(
				initialRoyaltyReceiverBalance + royaltyAmount + undistributedAmount
			);
		});

		it('should set and get mint price', async function () {
			const newMintPrice = ethers.parseUnits('150', 6);
			await contract.setMintPrice(newMintPrice);
			expect(await contract.mintPrice()).to.equal(newMintPrice);
		});

		it('should not allow non-owners to set mint price', async function () {
			const newMintPrice = ethers.parseUnits('150', 6);
			await expect(contract.connect(buyer).setMintPrice(newMintPrice)).to.be.revertedWith('Caller is not an owner');
		});

		it('should set base URI and retrieve token URI', async function () {
			const newBaseURI = 'https://new.api.kami.example/metadata/';
			await contract.setBaseURI(newBaseURI);

			const tx = await contract.connect(buyer).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);

			expect(await contract.uri(tokenId1)).to.equal(newBaseURI + tokenId1.toString());
		});
	});

	describe('Royalties', function () {
		let tokenId1: bigint;
		beforeEach(async function () {
			// Mint a token to test royalty settings on
			const tx = await contract.connect(buyer).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
		});

		it('should set and get royalty percentage', async function () {
			const newRoyaltyPercentage = 1500;
			await contract.setRoyaltyPercentage(newRoyaltyPercentage);
			expect(await contract.royaltyPercentage()).to.equal(newRoyaltyPercentage);
		});

		it('should set and get mint royalties', async function () {
			const royaltyData = [
				{ receiver: royaltyReceiver.address, feeNumerator: 7600 },
				{ receiver: owner.address, feeNumerator: 1900 },
			];
			await contract.setMintRoyalties(royaltyData);

			const receiverData = await contract.getMintRoyaltyReceivers(tokenId1);
			expect(receiverData.length).to.equal(2);
			expect(receiverData[0].receiver).to.equal(royaltyReceiver.address);
			expect(receiverData[0].feeNumerator).to.equal(7600);
			expect(receiverData[1].receiver).to.equal(owner.address);
			expect(receiverData[1].feeNumerator).to.equal(1900);
		});

		it('should set and get transfer royalties', async function () {
			const royaltyData = [
				{ receiver: royaltyReceiver.address, feeNumerator: 6000 },
				{ receiver: owner.address, feeNumerator: 4000 },
			];
			await contract.setTransferRoyalties(royaltyData);

			const receiverData = await contract.getTransferRoyaltyReceivers(tokenId1);
			expect(receiverData.length).to.equal(2);
			expect(receiverData[0].receiver).to.equal(royaltyReceiver.address);
			expect(receiverData[0].feeNumerator).to.equal(6000);
			expect(receiverData[1].receiver).to.equal(owner.address);
			expect(receiverData[1].feeNumerator).to.equal(4000);
		});
	});

	describe('Selling & Transfers', function () {
		let tokenId1: bigint;
		beforeEach(async function () {
			const mintRoyaltyData = [{ receiver: royaltyReceiver.address, feeNumerator: 9500 }];
			const transferRoyaltyData = [{ receiver: royaltyReceiver.address, feeNumerator: 10000 }];
			await contract.setMintRoyalties(mintRoyaltyData);
			await contract.setTransferRoyalties(transferRoyaltyData);

			// Mint a token for the owner
			await mockUSDC.mint(owner.address, ethers.parseUnits('1000', 6));
			await mockUSDC.connect(owner).approve(await contract.getAddress(), ethers.parseUnits('1000', 6));
			const tx = await contract.connect(owner).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
		});

		it('should sell a token with royalties', async function () {
			const salePrice = ethers.parseUnits('200', 6);

			const initialOwnerBalance = await mockUSDC.balanceOf(owner.address);
			const initialBuyerBalance = await mockUSDC.balanceOf(buyer.address);
			const initialPlatformBalance = await mockUSDC.balanceOf(platform.address);
			const initialRoyaltyReceiverBalance = await mockUSDC.balanceOf(royaltyReceiver.address);

			await contract.connect(owner).sellToken(buyer.address, tokenId1, salePrice);

			// Check token balance
			expect(await contract.balanceOf(owner.address, tokenId1)).to.equal(0);
			expect(await contract.balanceOf(buyer.address, tokenId1)).to.equal(1);

			const royaltyAmount = (salePrice * BigInt(await contract.royaltyPercentage())) / 10000n;
			const platformCommission = (salePrice * BigInt(PLATFORM_COMMISSION)) / 10000n;
			const royaltyDust = royaltyAmount - (royaltyAmount * 10000n) / 10000n; // Dust for 100% receiver
			const sellerProceeds = salePrice - (royaltyAmount + platformCommission);

			expect(await mockUSDC.balanceOf(buyer.address)).to.equal(initialBuyerBalance - salePrice);
			expect(await mockUSDC.balanceOf(owner.address)).to.equal(initialOwnerBalance + sellerProceeds);
			expect(await mockUSDC.balanceOf(platform.address)).to.equal(initialPlatformBalance + platformCommission);
			expect(await mockUSDC.balanceOf(royaltyReceiver.address)).to.equal(initialRoyaltyReceiverBalance + royaltyAmount + royaltyDust);
		});
	});

	describe('Rental Functionality', function () {
		let tokenId1: bigint;
		const rentalPrice = ethers.parseUnits('50', 6);
		const rentalDuration = 86400; // 1 day

		beforeEach(async function () {
			await mockUSDC.mint(owner.address, ethers.parseUnits('1000', 6));
			await mockUSDC.connect(owner).approve(await contract.getAddress(), ethers.parseUnits('1000', 6));
			const tx = await contract.connect(owner).mint();
			const receipt = await tx.wait();
			tokenId1 = getTokenIdFromMintReceipt(receipt);
			// Approve buyer for rental payments
			await mockUSDC.connect(buyer).approve(await contract.getAddress(), ethers.parseUnits('1000', 6));
		});

		it('should rent a token', async function () {
			const initialOwnerBalance = await mockUSDC.balanceOf(owner.address);
			const initialBuyerBalance = await mockUSDC.balanceOf(buyer.address);
			const initialPlatformBalance = await mockUSDC.balanceOf(platform.address);

			await contract.connect(buyer).rentToken(tokenId1, rentalDuration, rentalPrice);

			const rentalInfo = await contract.getRentalInfo(tokenId1);
			expect(rentalInfo.owner).to.equal(owner.address);
			expect(rentalInfo.renter).to.equal(buyer.address);
			expect(rentalInfo.active).to.be.true;

			const platformCommission = (rentalPrice * BigInt(PLATFORM_COMMISSION)) / 10000n;
			const ownerShare = rentalPrice - platformCommission;

			expect(await mockUSDC.balanceOf(buyer.address)).to.equal(initialBuyerBalance - rentalPrice);
			expect(await mockUSDC.balanceOf(owner.address)).to.equal(initialOwnerBalance + ownerShare);
			expect(await mockUSDC.balanceOf(platform.address)).to.equal(initialPlatformBalance + platformCommission);

			const RENTER_ROLE = await contract.RENTER_ROLE();
			expect(await contract.hasRole(RENTER_ROLE, buyer.address)).to.be.true;
		});

		it('should end rental', async function () {
			await contract.connect(buyer).rentToken(tokenId1, rentalDuration, rentalPrice);
			await contract.connect(owner).endRental(tokenId1);

			const rentalInfo = await contract.getRentalInfo(tokenId1);
			expect(rentalInfo.active).to.be.false;
			expect(await contract.isRented(tokenId1)).to.be.false;
		});

		it('should extend rental', async function () {
			await contract.connect(buyer).rentToken(tokenId1, rentalDuration, rentalPrice);

			const rentalInfo = await contract.getRentalInfo(tokenId1);
			const originalEndTime = rentalInfo.endTime;

			const additionalDuration = 43200;
			const additionalPayment = ethers.parseUnits('25', 6);
			await contract.connect(buyer).extendRental(tokenId1, additionalDuration, additionalPayment);

			const updatedRentalInfo = await contract.getRentalInfo(tokenId1);
			expect(updatedRentalInfo.endTime).to.equal(originalEndTime + BigInt(additionalDuration));
			expect(updatedRentalInfo.rentalPrice).to.equal(rentalPrice + additionalPayment);
			expect(updatedRentalInfo.active).to.be.true;
		});
	});

	describe('Upgradeability', function () {
		it('should be managed by ProxyAdmin', async function () {
			const proxyAddress = await contract.getAddress();
			const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
			expect(adminAddress).to.not.equal(ethers.ZeroAddress);

			const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
			expect(implementationAddress).to.not.equal(ethers.ZeroAddress);
		});
	});
});
