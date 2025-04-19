// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title KAMI1155CUpgradeable
 * @dev An upgradeable ERC1155 implementation with USDC payments, programmable royalties, and rental functionality
 */
contract KAMI1155CUpgradeable is 
    Initializable, 
    AccessControlUpgradeable, 
    ERC1155Upgradeable, 
    ERC2981Upgradeable, 
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Counters for Counters.Counter;
    using Strings for uint256;
    
    // Role definitions
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant RENTER_ROLE = keccak256("RENTER_ROLE");
    bytes32 public constant PLATFORM_ROLE = keccak256("PLATFORM_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    
    // Using Counter for token IDs (unique ERC1155 IDs)
    Counters.Counter private _tokenIdCounter;
    uint256 public mintPrice;
    string private _baseTokenURI;
    
    // Platform commission details
    uint96 public platformCommissionPercentage;
    address public platformAddress;
    
    // USDC token contract
    IERC20 public usdcToken;
    
    // Struct to represent a royalty recipient
    struct RoyaltyData {
        address receiver;
        uint96 feeNumerator;
    }
    
    // Arrays to store multiple royalty receivers
    RoyaltyData[] private _mintRoyaltyReceivers;
    RoyaltyData[] private _transferRoyaltyReceivers;
    
    // Mapping from token ID to custom royalty info (using id)
    mapping(uint256 => RoyaltyData[]) private _tokenMintRoyalties;
    mapping(uint256 => RoyaltyData[]) private _tokenTransferRoyalties;
    
    // Royalty percentage for transfers
    uint96 public royaltyPercentage;
    
    // Rental functionality (maps unique token ID to rental info)
    struct Rental {
        address owner; // Store owner at time of rental start
        address renter;
        uint256 startTime;
        uint256 endTime;
        uint256 rentalPrice;
        bool active;
    }
    
    // Mapping from token ID (id) to rental information
    mapping(uint256 => Rental) private _rentals;

    // Keep track of owners for IDs minted with amount 1 (for rental logic)
    mapping(uint256 => address) private _uniqueIdOwner;
    
    // Events (interpret tokenId as id)
    event MintRoyaltiesUpdated(RoyaltyData[] royalties);
    event TransferRoyaltiesUpdated(RoyaltyData[] royalties);
    event TokenMintRoyaltiesUpdated(uint256 indexed id, RoyaltyData[] royalties);
    event TokenTransferRoyaltiesUpdated(uint256 indexed id, RoyaltyData[] royalties);
    event TransferRoyaltyDistributed(uint256 indexed id, address indexed receiver, uint256 amount);
    event PlatformCommissionPaid(uint256 indexed id, address indexed platformAddress, uint256 amount);
    event RoyaltyPercentageUpdated(uint96 newPercentage);
    event PlatformCommissionUpdated(uint96 newPercentage, address newPlatformAddress);
    event TokenSold(uint256 indexed id, address indexed from, address indexed to, uint256 salePrice);
    event TokenRented(uint256 indexed id, address indexed owner, address indexed renter, uint256 startTime, uint256 endTime, uint256 rentalPrice);
    event RentalEnded(uint256 indexed id, address indexed owner, address indexed renter);
    event RentalExtended(uint256 indexed id, address indexed renter, uint256 newEndTime);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /**
     * @dev Initializes the contract
     */
    function initialize(
        address usdcAddress_,
        string memory baseTokenURI_,
        uint256 initialMintPrice_,
        address platformAddress_,
        uint96 platformCommissionPercentage_
    ) public initializer {
        require(usdcAddress_ != address(0), "Invalid USDC address");
        require(platformAddress_ != address(0), "Invalid platform address");
        require(platformCommissionPercentage_ <= 2000, "Platform commission too high");
        
        __ERC1155_init(baseTokenURI_);
        __AccessControl_init();
        __ERC2981_init();
        __Pausable_init();
        __UUPSUpgradeable_init();
        
        usdcToken = IERC20(usdcAddress_);
        _baseTokenURI = baseTokenURI_;
        mintPrice = initialMintPrice_;
        platformAddress = platformAddress_;
        platformCommissionPercentage = platformCommissionPercentage_;
        royaltyPercentage = 1000; // Default to 10%
        
        // Grant roles
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OWNER_ROLE, msg.sender);
        _grantRole(PLATFORM_ROLE, platformAddress_);
        _grantRole(UPGRADER_ROLE, msg.sender);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}

    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        virtual 
        override(AccessControlUpgradeable, ERC1155Upgradeable, ERC2981Upgradeable)
        returns (bool) 
    {
        return interfaceId == type(IERC1155Upgradeable).interfaceId
            || interfaceId == type(IERC2981Upgradeable).interfaceId
            || super.supportsInterface(interfaceId);
    }
    
    /**
     * @dev See {IERC1155MetadataURI-uri}.
     */
    function uri(uint256 id) public view virtual override returns (string memory) {
        require(_exists(id), "URI: nonexistent id");
        return string(abi.encodePacked(_baseTokenURI, id.toString()));
    }

    function setBaseURI(string memory baseURI_) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        _baseTokenURI = baseURI_;
    }

    // --- Platform Commission ---
    function setPlatformCommission(uint96 newPlatformCommissionPercentage, address newPlatformAddress) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        require(newPlatformAddress != address(0), "Invalid platform address");
        require(newPlatformCommissionPercentage <= 2000, "Platform commission too high");
        
        address oldPlatformAddress = platformAddress;
        platformCommissionPercentage = newPlatformCommissionPercentage;
        platformAddress = newPlatformAddress;
        
        if (oldPlatformAddress != newPlatformAddress) {
            if (hasRole(PLATFORM_ROLE, oldPlatformAddress)) {
                _revokeRole(PLATFORM_ROLE, oldPlatformAddress);
            }
            _grantRole(PLATFORM_ROLE, newPlatformAddress);
        }
        
        emit PlatformCommissionUpdated(newPlatformCommissionPercentage, newPlatformAddress);
    }

    // --- Royalty Logic ---
    function setRoyaltyPercentage(uint96 newRoyaltyPercentage) external { 
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        require(newRoyaltyPercentage <= 3000, "Royalty percentage too high");
        
        royaltyPercentage = newRoyaltyPercentage;
        // Update default royalty for ERC2981 using the first transfer receiver if available, else address(0)
        address defaultReceiver = _transferRoyaltyReceivers.length > 0 ? _transferRoyaltyReceivers[0].receiver : address(0);
        _setDefaultRoyalty(defaultReceiver, newRoyaltyPercentage);
        emit RoyaltyPercentageUpdated(newRoyaltyPercentage);
    }
    
    function setMintRoyalties(RoyaltyData[] calldata royalties) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        delete _mintRoyaltyReceivers;
        uint96 totalFees = 0;
        for (uint i = 0; i < royalties.length; i++) {
            require(royalties[i].receiver != address(0), "Invalid receiver");
            totalFees += royalties[i].feeNumerator;
            _mintRoyaltyReceivers.push(royalties[i]);
        }
        require(totalFees + platformCommissionPercentage <= 10000, "Royalties + commission exceed 100%");
        emit MintRoyaltiesUpdated(royalties);
    }
    
    function setTransferRoyalties(RoyaltyData[] calldata royalties) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        delete _transferRoyaltyReceivers;
        uint96 totalFees = 0;
        address firstReceiver = address(0);
        for (uint i = 0; i < royalties.length; i++) {
            require(royalties[i].receiver != address(0), "Invalid receiver");
            totalFees += royalties[i].feeNumerator;
            _transferRoyaltyReceivers.push(royalties[i]);
            if (i == 0) firstReceiver = royalties[i].receiver;
        }
        require(totalFees == 10000, "Transfer royalties must equal 100%");
        
        // Update default royalty for ERC2981
        _setDefaultRoyalty(firstReceiver, royaltyPercentage); 
        
        emit TransferRoyaltiesUpdated(royalties);
    }
    
    function setTokenMintRoyalties(uint256 id, RoyaltyData[] calldata royalties) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        require(_exists(id), "Token ID does not exist");
        
        delete _tokenMintRoyalties[id];
        uint96 totalFees = 0;
        for (uint i = 0; i < royalties.length; i++) {
            require(royalties[i].receiver != address(0), "Invalid receiver");
            totalFees += royalties[i].feeNumerator;
            _tokenMintRoyalties[id].push(royalties[i]);
        }
        require(totalFees + platformCommissionPercentage <= 10000, "Royalties + commission exceed 100%");
        emit TokenMintRoyaltiesUpdated(id, royalties);
    }
    
    function setTokenTransferRoyalties(uint256 id, RoyaltyData[] calldata royalties) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        require(_exists(id), "Token ID does not exist");
        
        delete _tokenTransferRoyalties[id];
        uint96 totalFees = 0;
        address firstReceiver = address(0);
        for (uint i = 0; i < royalties.length; i++) {
            require(royalties[i].receiver != address(0), "Invalid receiver");
            totalFees += royalties[i].feeNumerator;
            _tokenTransferRoyalties[id].push(royalties[i]);
             if (i == 0) firstReceiver = royalties[i].receiver;
        }
        require(totalFees == 10000, "Transfer royalties must equal 100%");
        
        // Update token-specific royalty for ERC2981
         _setTokenRoyalty(id, firstReceiver, royaltyPercentage); 
        
        emit TokenTransferRoyaltiesUpdated(id, royalties);
    }
    
    function royaltyInfo(uint256 id, uint256 salePrice)
        public 
        view 
        override(ERC2981Upgradeable)
        returns (address receiver, uint256 royaltyAmount) 
    {
        // Returns info based on ERC2981's internal storage (_defaultRoyalties or _royalties[id])
        // which should be set via _setDefaultRoyalty/_setTokenRoyalty in setters above.
        return super.royaltyInfo(id, salePrice);
    }
    
    // Function to get all mint royalty receivers for a token (id)
    function getMintRoyaltyReceivers(uint256 id) 
        public view returns (RoyaltyData[] memory) // Changed visibility to public
    {
        return _tokenMintRoyalties[id].length > 0 ? _tokenMintRoyalties[id] : _mintRoyaltyReceivers;
    }
    
    // Function to get all transfer royalty receivers for a token (id)
    function getTransferRoyaltyReceivers(uint256 id) 
        public view returns (RoyaltyData[] memory) // Changed visibility to public
    {
        return _tokenTransferRoyalties[id].length > 0 ? _tokenTransferRoyalties[id] : _transferRoyaltyReceivers;
    }

    // --- Minting ---
    function mint() external whenNotPaused {
        uint256 platformCommission = (mintPrice * platformCommissionPercentage) / 10000;
        RoyaltyData[] memory royalties = _mintRoyaltyReceivers;
        uint256 remainingAmount = mintPrice - platformCommission;
        
        usdcToken.safeTransferFrom(msg.sender, address(this), mintPrice);
        
        // Generate new unique ID *before* transfers in case of reentrancy
        _tokenIdCounter.increment();
        uint256 newId = _tokenIdCounter.current();

        if (platformCommission > 0) {
            usdcToken.safeTransfer(platformAddress, platformCommission);
            emit PlatformCommissionPaid(newId, platformAddress, platformCommission);
        }
        
        uint256 totalDistributed = 0;
        if (royalties.length > 0) {
            for (uint i = 0; i < royalties.length; i++) {
                uint256 amount = (remainingAmount * royalties[i].feeNumerator) / 10000;
                if (amount > 0) {
                    usdcToken.safeTransfer(royalties[i].receiver, amount);
                    totalDistributed += amount;
                }
            }
        }
        
        uint256 undistributed = remainingAmount - totalDistributed;
        if (undistributed > 0) {
            address receiver = royalties.length > 0 ? royalties[0].receiver : platformAddress;
            usdcToken.safeTransfer(receiver, undistributed);
        }
        
        // Mint amount 1 of the new ID
        _mint(msg.sender, newId, 1, ""); 
        // _uniqueIdOwner tracking happens in _beforeTokenTransfer hook
        
        emit TokenSold(newId, msg.sender, address(this), mintPrice);
    }
    
    // --- Selling ---
    function sellToken(address to, uint256 id, uint256 salePrice) external whenNotPaused {
        address seller = msg.sender;
        require(balanceOf(seller, id) >= 1, "Seller does not own token ID");
        require(!_rentals[id].active || block.timestamp >= _rentals[id].endTime, "Token is actively rented");
        
        uint256 royaltyAmountTotal = (salePrice * royaltyPercentage) / 10000;
        uint256 platformCommission = (salePrice * platformCommissionPercentage) / 10000;
        require(royaltyAmountTotal + platformCommission <= salePrice, "Royalties+commission exceed price");
        uint256 sellerProceeds = salePrice - royaltyAmountTotal - platformCommission;
        
        usdcToken.safeTransferFrom(to, address(this), salePrice);
        
        if (royaltyAmountTotal > 0) {
            RoyaltyData[] memory royalties = getTransferRoyaltyReceivers(id);
            if (royalties.length > 0) {
                uint256 distributed = 0;
                for (uint i = 0; i < royalties.length; i++) {
                    uint256 amount = (royaltyAmountTotal * royalties[i].feeNumerator) / 10000; 
                    if (amount > 0) {
                        if (distributed + amount <= royaltyAmountTotal) { 
                            usdcToken.safeTransfer(royalties[i].receiver, amount);
                            emit TransferRoyaltyDistributed(id, royalties[i].receiver, amount);
                            distributed += amount;
                        } else if (i == royalties.length - 1) { 
                            uint256 remaining = royaltyAmountTotal - distributed;
                            if (remaining > 0) {
                                usdcToken.safeTransfer(royalties[i].receiver, remaining);
                                emit TransferRoyaltyDistributed(id, royalties[i].receiver, remaining);
                                distributed += remaining;
                            }
                        }
                    }
                }
                 uint256 royaltyDust = royaltyAmountTotal - distributed;
                 if(royaltyDust > 0 && royalties.length > 0) {
                     usdcToken.safeTransfer(royalties[0].receiver, royaltyDust);
                     emit TransferRoyaltyDistributed(id, royalties[0].receiver, royaltyDust);
                 }
            }
        }
        
        if (platformCommission > 0) {
            usdcToken.safeTransfer(platformAddress, platformCommission);
            emit PlatformCommissionPaid(id, platformAddress, platformCommission);
        }
        
        usdcToken.safeTransfer(seller, sellerProceeds);
        
        // Transfer the token (amount 1)
        safeTransferFrom(seller, to, id, 1, "");
        // _uniqueIdOwner tracking happens in _beforeTokenTransfer hook
        
        emit TokenSold(id, seller, to, salePrice);
    }

    // --- Rental Logic ---
    function rentToken(uint256 id, uint256 duration, uint256 rentalPrice) external whenNotPaused {
        require(_exists(id), "Token ID does not exist");
        require(!_rentals[id].active || block.timestamp >= _rentals[id].endTime, "Token is actively rented");
        require(duration > 0, "Rental duration > 0");
        require(rentalPrice > 0, "Rental price > 0");
        
        address tokenOwner = _uniqueIdOwner[id];
        require(tokenOwner != address(0), "Cannot determine owner");
        require(balanceOf(tokenOwner, id) >= 1, "Owner balance mismatch"); 
        require(tokenOwner != msg.sender, "Owner cannot rent");
        
        uint256 platformCommission = (rentalPrice * platformCommissionPercentage) / 10000;
        require(platformCommission <= rentalPrice, "Commission exceeds price");
        uint256 ownerShare = rentalPrice - platformCommission;
        
        usdcToken.safeTransferFrom(msg.sender, address(this), rentalPrice);
        
        if (platformCommission > 0) {
            usdcToken.safeTransfer(platformAddress, platformCommission);
            emit PlatformCommissionPaid(id, platformAddress, platformCommission);
        }
        usdcToken.safeTransfer(tokenOwner, ownerShare);
        
        _rentals[id] = Rental({
            owner: tokenOwner,
            renter: msg.sender,
            startTime: block.timestamp,
            endTime: block.timestamp + duration,
            rentalPrice: rentalPrice,
            active: true
        });
        
        _grantRole(RENTER_ROLE, msg.sender);
        emit TokenRented(id, tokenOwner, msg.sender, block.timestamp, block.timestamp + duration, rentalPrice);
    }
    
    function endRental(uint256 id) external {
        require(_exists(id), "Token ID does not exist");
        Rental storage rental = _rentals[id];
        require(rental.active, "Token is not rented");
        
        address tokenOwner = rental.owner;
        address renter = rental.renter;
        // Allow ending if past end time, regardless of caller
        if (block.timestamp >= rental.endTime) {
             // proceed to end
        } else {
            require(msg.sender == tokenOwner || msg.sender == renter, "Only owner or renter can end early");
        }
        
        rental.active = false;
        _revokeRole(RENTER_ROLE, renter); 
        emit RentalEnded(id, tokenOwner, renter);
    }
    
    function extendRental(uint256 id, uint256 additionalDuration, uint256 additionalPayment) external whenNotPaused {
         require(_exists(id), "Token ID does not exist");
         Rental storage rental = _rentals[id];
         require(rental.active, "Token is not rented");
         require(block.timestamp < rental.endTime, "Rental already ended"); // Cannot extend ended rental
         require(additionalDuration > 0, "Duration > 0");
         require(additionalPayment > 0, "Payment > 0");
         require(msg.sender == rental.renter, "Only renter can extend");

         address tokenOwner = rental.owner;
         
         uint256 platformCommission = (additionalPayment * platformCommissionPercentage) / 10000;
         require(platformCommission <= additionalPayment, "Commission exceeds payment");
         uint256 ownerShare = additionalPayment - platformCommission;
         
         usdcToken.safeTransferFrom(msg.sender, address(this), additionalPayment);
         
         if (platformCommission > 0) {
             usdcToken.safeTransfer(platformAddress, platformCommission);
             emit PlatformCommissionPaid(id, platformAddress, platformCommission);
         }
         usdcToken.safeTransfer(tokenOwner, ownerShare);
         
         rental.endTime += additionalDuration;
         rental.rentalPrice += additionalPayment;
         
         emit RentalExtended(id, msg.sender, rental.endTime);
    }
    
    function isRented(uint256 id) external view returns (bool) {
        return _rentals[id].active && block.timestamp < _rentals[id].endTime;
    }
    
    function getRentalInfo(uint256 id) external view returns (
        address owner,
        address renter,
        uint256 startTime,
        uint256 endTime,
        uint256 rentalPrice,
        bool active
    ) {
        Rental memory rental = _rentals[id];
        bool currentlyActive = rental.active && block.timestamp < rental.endTime; 
        return (rental.owner, rental.renter, rental.startTime, rental.endTime, rental.rentalPrice, currentlyActive);
    }
    
    // --- Burning ---
    function burn(uint256 id) external {
        require(balanceOf(msg.sender, id) >= 1, "Caller does not own token ID");
        require(!_rentals[id].active || block.timestamp >= _rentals[id].endTime, "Token is actively rented");
        _burn(msg.sender, id, 1);
        // Owner tracking is handled in _beforeTokenTransfer
        delete _rentals[id]; // Clean up rental info
        delete _tokenMintRoyalties[id]; // Clean up royalties
        delete _tokenTransferRoyalties[id];
    }

    // --- Admin / Pausable ---
    function setMintPrice(uint256 newMintPrice) external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        mintPrice = newMintPrice;
    }
    
    function pause() external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        _pause();
    }
    
    function unpause() external {
        require(hasRole(OWNER_ROLE, msg.sender), "Caller is not an owner");
        _unpause();
    }

    // --- Internal Overrides & Helpers ---

    function _beforeTokenTransfer(
        address operator,
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) internal virtual override(ERC1155Upgradeable) {
        super._beforeTokenTransfer(operator, from, to, ids, amounts, data); // Call parent ERC1155 logic
        require(!paused(), "ERC1155Pausable: token transfer while paused");

        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            uint256 amount = amounts[i];
            require(amount == 1, "Only amount 1 supported"); // Enforce NFT-like behavior

            Rental storage rental = _rentals[id];

            // Update owner tracking
            if (from == address(0)) { // Mint
                _uniqueIdOwner[id] = to;
            } else if (to == address(0)) { // Burn
                delete _uniqueIdOwner[id];
            } else { // Transfer
                 _uniqueIdOwner[id] = to;
            }

            // Check rental status only for transfers (not mint/burn)
            if (from != address(0) && to != address(0)) {
                 if (rental.active) {
                    if (block.timestamp >= rental.endTime) {
                        rental.active = false;
                        _revokeRole(RENTER_ROLE, rental.renter);
                        emit RentalEnded(id, rental.owner, rental.renter);
                    } else {
                        // Active rental, prevent transfer
                        revert("Token is locked during rental period"); 
                    }
                }
            }
        }
    }

    // Helper to check if an ID likely exists (was minted)
    function _exists(uint256 id) internal view returns (bool) {
        // Check if the counter has reached this ID
        // Note: Does not check if it was burned. Use balanceOf for current ownership.
        return id > 0 && id <= _tokenIdCounter.current();
    }

    // --- Storage Gap ---
    uint256[49] private __gap; // Adjusted gap due to added _uniqueIdOwner mapping
} 