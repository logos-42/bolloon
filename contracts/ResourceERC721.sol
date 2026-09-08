// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ResourceERC721 — Bolloon 数字资源资产化 Stage 1-B 的极简 ERC-721 合约定制实现.
//   无第三方依赖 (不引 OpenZeppelin), 便于 forge/remix 直接编译部署.
//   mint(address,uint256,string): 铸币, tokenURI 存 CID (内容寻址) 作为 metadata 指针 — 可流转/可查.
//   safeTransferFrom / approve: 所有权转移 (流转).
contract ResourceERC721 {
    mapping(uint256 => address) private _owner;
    mapping(address => uint256) private _balance;
    mapping(uint256 => address) private _approved;
    mapping(uint256 => string) private _tokenUri;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    function mint(address to, uint256 tokenId, string memory tokenUri) external {
        require(to != address(0), "zero to");
        require(_owner[tokenId] == address(0), "exists");
        _owner[tokenId] = to;
        _balance[to] += 1;
        _tokenUri[tokenId] = tokenUri;
        emit Transfer(address(0), to, tokenId);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owner[tokenId];
        require(o != address(0), "not minted");
        return o;
    }

    function balanceOf(address a) external view returns (uint256) {
        return _balance[a];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return _tokenUri[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        require(msg.sender == _owner[tokenId], "not owner");
        _approved[tokenId] = to;
        emit Approval(msg.sender, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(_owner[tokenId] == from, "not from");
        require(msg.sender == from || msg.sender == _approved[tokenId], "not authorized");
        require(to != address(0), "zero to");
        _owner[tokenId] = to;
        _approved[tokenId] = address(0);
        _balance[from] -= 1;
        _balance[to] += 1;
        emit Transfer(from, to, tokenId);
    }
}
