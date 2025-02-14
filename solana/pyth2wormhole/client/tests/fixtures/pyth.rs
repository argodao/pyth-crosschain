//! This module contains test fixtures for instantiating plausible
//! Pyth accounts for testing purposes.
use solana_program_test::*;

use solana_sdk::{
    account::Account,
    pubkey::Pubkey,
    rent::Rent,
};

use pyth_client::{
    AccKey,
    AccountType,
    Price,
    Product,
    MAGIC,
    PROD_ATTR_SIZE,
    VERSION,
};

/// Create a pair of brand new product/price accounts that point at each other
pub fn add_test_symbol(pt: &mut ProgramTest, owner: &Pubkey) -> (Pubkey, Pubkey) {
    // Generate pubkeys
    let prod_id = Pubkey::new_unique();
    let price_id = Pubkey::new_unique();

    // Instantiate
    let prod = {
        Product {
            magic: MAGIC,
            ver: VERSION,
            atype: AccountType::Product as u32,
            size: 0,
            px_acc: AccKey {
                val: price_id.to_bytes(),
            },
            attr: [0u8; PROD_ATTR_SIZE],
        }
    };

    let mut price = Price {
        magic: MAGIC,
        ver: VERSION,
        atype: AccountType::Price as u32,
        prod: AccKey {
            val: prod_id.to_bytes(),
        },
        ..Default::default()
    };

    // Cast to raw bytes
    let prod_buf = &[prod];
    let prod_bytes = unsafe {
        let (_prefix, bytes, _suffix) = prod_buf.align_to::<u8>();
        bytes
    };
    let price_buf = &[price];
    let price_bytes = unsafe {
        let (_prefix, bytes, _suffix) = price_buf.align_to::<u8>();
        bytes
    };

    // Compute exemption rent
    let prod_lamports = Rent::default().minimum_balance(prod_bytes.len());
    let price_lamports = Rent::default().minimum_balance(price_bytes.len());

    // Populate the accounts
    let mut prod_acc = Account {
        lamports: prod_lamports,
        data: (*prod_bytes).to_vec(),
        owner: owner.clone(),
        rent_epoch: 0,
        executable: false,
    };
    let mut price_acc = Account {
        lamports: price_lamports,
        data: (*price_bytes).to_vec(),
        owner: owner.clone(),
        rent_epoch: 0,
        executable: false,
    };

    pt.add_account(prod_id, prod_acc);
    pt.add_account(price_id, price_acc);

    (prod_id, price_id)
}
