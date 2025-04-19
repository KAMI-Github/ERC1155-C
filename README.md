# KAMI1155C - Upgradeable ERC1155 NFT Contract

KAMI1155C is an advanced ERC1155 NFT contract supporting unique token IDs (amount=1) with programmable royalties, rental functionality, and USDC payment integration. This repository contains both the standard implementation and an upgradeable version using OpenZeppelin's transparent proxy pattern.

## Features

-   **ERC1155 Standard**: Implements the ERC1155 standard for multi-token contracts, used here for non-fungible tokens (each ID has amount 1)
-   **Programmable Royalties**: Configurable royalty distribution for both minting and transfers
-   **Rental System**: Built-in functionality for renting NFTs (specific IDs) with time-based access control
-   **USDC Payments**: Integration with USDC for minting, selling, and rental payments
-   **Platform Commission**: Configurable platform fee for all transactions
-   **Role-Based Access Control**: Secure permission system for different contract functions
-   **Upgradeable Architecture**: Transparent proxy pattern for future upgrades (for `KAMI1155CUpgradeable`)

## Contract Architecture

### KAMI1155C (Standard Version)

The standard `KAMI1155C` contract is a non-upgradeable ERC1155 implementation with the following key components:

-   **Access Control**: Uses OpenZeppelin's AccessControl for role-based permissions
-   **ERC2981**: Implements the ERC2981 standard for royalty information
-   **ERC1155**: Base implementation for multi-token standard
-   **Pausable**: Allows pausing of contract operations in emergencies

### KAMI1155CUpgradeable

The upgradeable version consists of three main contracts:

1.  **KAMI1155CUpgradeable.sol**: The implementation contract with UUPS upgradeability
2.  **ProxyAdmin.sol**: The standard OpenZeppelin admin contract for managing the proxy
3.  **TransparentUpgradeableProxy.sol**: The standard OpenZeppelin proxy contract

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd <your-repo-directory>

# Install dependencies
npm install
```

## Deployment

### Standard Contract

```bash
npx hardhat run scripts/deploy.ts --network <network-name>
```

_(Note: Update `scripts/deploy.ts` if needed to deploy `KAMI1155C`)_

### Upgradeable Contract

```bash
npx hardhat run scripts/deploy_upgradeable.ts --network <network-name>
```

_(Note: Update `scripts/deploy_upgradeable.ts` if needed to deploy `KAMI1155CUpgradeable`)_

## Usage Examples

### Initializing the Contract (Standard Version)

```javascript
// Deploy the contract
const KAMI1155C = await ethers.getContractFactory('KAMI1155C');
const kami = await KAMI1155C.deploy(
	usdcAddress,
	'https://api.kami.example/metadata/', // Base URI
	ethers.parseUnits('100', 6), // 100 USDC mint price
	platformAddress,
	500 // 5% platform commission
);
await kami.waitForDeployment();
const kamiAddress = await kami.getAddress();
```

### Initializing the Contract (Upgradeable Version)

```javascript
const KAMI1155CUpgradeable = await ethers.getContractFactory('KAMI1155CUpgradeable');
const kamiProxy = await upgrades.deployProxy(
	KAMI1155CUpgradeable,
	[
		usdcAddress,
		'https://api.kami.example/metadata/', // Base URI
		ethers.parseUnits('100', 6), // 100 USDC mint price
		platformAddress,
		500, // 5% platform commission
	],
	{
		initializer: 'initialize',
		kind: 'transparent',
	}
);
await kamiProxy.waitForDeployment();
const kamiAddress = await kamiProxy.getAddress();
```

### Setting Royalties

```javascript
// Set mint royalties
const mintRoyalties = [
	{
		receiver: creatorAddress,
		feeNumerator: 9500, // 95% (must be <= 10000 - platformCommissionPercentage)
	},
];
await kami.setMintRoyalties(mintRoyalties);

// Set transfer royalties (must sum to 10000)
const transferRoyalties = [
	{
		receiver: creatorAddress,
		feeNumerator: 10000, // 100% of the royalty amount defined by royaltyPercentage
	},
];
await kami.setTransferRoyalties(transferRoyalties);

// Set overall transfer royalty percentage (e.g., 10%)
await kami.setRoyaltyPercentage(1000);
```

### Minting NFTs

```javascript
// Approve USDC spending
await usdc.connect(buyer).approve(kamiAddress, ethers.parseUnits('100', 6));

// Mint an NFT (ID will be auto-incremented, e.g., 1 for the first mint)
const tx = await kami.connect(buyer).mint();
const receipt = await tx.wait();

// Helper to find the minted ID from events (example)
let tokenId = null;
for (const log of receipt.logs) {
	try {
		const parsedLog = kami.interface.parseLog(log);
		if (parsedLog && parsedLog.name === 'TransferSingle' && parsedLog.args.from === ethers.ZeroAddress) {
			tokenId = parsedLog.args.id;
			break;
		}
	} catch (e) {}
}
console.log('Minted Token ID:', tokenId?.toString()); // Should be 1 for the first mint
```

### Selling NFTs

```javascript
// Buyer approves USDC spending
const salePrice = ethers.parseUnits('200', 6);
await usdc.connect(buyer).approve(kamiAddress, salePrice);

// Seller calls sellToken
// No ERC721 approve needed from seller for ERC1155
await kami.connect(seller).sellToken(buyerAddress, tokenId, salePrice);
```

### Renting NFTs

```javascript
// Renter approves USDC spending
const rentalDuration = 86400; // 1 day in seconds
const rentalPrice = ethers.parseUnits('50', 6);
await usdc.connect(renter).approve(kamiAddress, rentalPrice);

// Rent a token
await kami.connect(renter).rentToken(tokenId, rentalDuration, rentalPrice);

// End a rental (either owner or renter)
await kami.connect(owner).endRental(tokenId);

// Extend a rental (renter approves additional payment first)
const additionalDuration = 43200; // 12 hours
const additionalPayment = ethers.parseUnits('25', 6);
await usdc.connect(renter).approve(kamiAddress, additionalPayment);
await kami.connect(renter).extendRental(tokenId, additionalDuration, additionalPayment);
```

### Upgrading the Contract (Upgradeable Version)

```javascript
// Deploy a new implementation
const KAMI1155CUpgradeableV2 = await ethers.getContractFactory('KAMI1155CUpgradeableV2');
await upgrades.upgradeProxy(kamiAddress, KAMI1155CUpgradeableV2);
```

## Testing

Run the test suite:

```bash
npx hardhat test
```

## Contract Functions

### Core Functions

-   `mint()`: Mint a new unique token ID (amount 1) by paying the mint price in USDC
-   `sellToken(address to, uint256 id, uint256 salePrice)`: Sell a token ID (amount 1) with royalty distribution
-   `rentToken(uint256 id, uint256 duration, uint256 rentalPrice)`: Rent a token ID for a specified duration
-   `endRental(uint256 id)`: End a rental early
-   `extendRental(uint256 id, uint256 additionalDuration, uint256 additionalPayment)`: Extend a rental period
-   `uri(uint256 id)`: Returns the URI for a given token ID
-   `balanceOf(address account, uint256 id)`: Gets the balance of a token ID for an account (should be 0 or 1)
-   `safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)`: Transfers a token ID (use amount=1)
-   `safeBatchTransferFrom(...)`: Transfers multiple token IDs
-   `setApprovalForAll(address operator, bool approved)`: Approves an operator for all tokens of the caller
-   `isApprovedForAll(address account, address operator)`: Checks if an operator is approved

### Royalty Management

-   `setMintRoyalties(RoyaltyData[] calldata royalties)`: Set default royalties for minting
-   `setTransferRoyalties(RoyaltyData[] calldata royalties)`: Set default royalties for transfers (must sum to 10000)
-   `setTokenMintRoyalties(uint256 id, RoyaltyData[] calldata royalties)`: Set token-specific mint royalties
-   `setTokenTransferRoyalties(uint256 id, RoyaltyData[] calldata royalties)`: Set token-specific transfer royalties (must sum to 10000)
-   `getMintRoyaltyReceivers(uint256 id)`: Get mint royalty receivers for a token ID
-   `getTransferRoyaltyReceivers(uint256 id)`: Get transfer royalty receivers for a token ID
-   `royaltyInfo(uint256 id, uint256 salePrice)`: ERC2981 standard royalty info (uses `royaltyPercentage`)

### Configuration

-   `setMintPrice(uint256 newMintPrice)`: Set the mint price
-   `setPlatformCommission(uint96 newPlatformCommissionPercentage, address newPlatformAddress)`: Set platform commission
-   `setRoyaltyPercentage(uint96 newRoyaltyPercentage)`: Set the overall royalty percentage for transfers (used by `royaltyInfo` and `sellToken`)
-   `setBaseURI(string memory baseURI)`: Set the base URI prefix for token metadata

### Administrative

-   `pause()`: Pause the contract
-   `unpause()`: Unpause the contract
-   `burn(uint256 id)`: Burn a token ID (amount 1)

## Roles

-   `DEFAULT_ADMIN_ROLE`: Can manage all roles
-   `OWNER_ROLE`: Can configure the contract and manage royalties
-   `PLATFORM_ROLE`: Receives platform commission
-   `RENTER_ROLE`: Granted to users who rent NFTs
-   `UPGRADER_ROLE`: Can upgrade the implementation (upgradeable version only)

## License

MIT
