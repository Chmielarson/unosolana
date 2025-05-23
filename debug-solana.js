// debug-solana.js - Skrypt do testowania połączenia z programem Solana
require('dotenv').config();
const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');

// Konfiguracja
const NETWORK = process.env.REACT_APP_SOLANA_NETWORK || 'devnet';
const PROGRAM_ID = new PublicKey(process.env.REACT_APP_PROGRAM_ID || 'fugHC2jFBQSBmUfo4qZesJTBHXoaRMUpCYSkUppWtP9');
const connection = new Connection(clusterApiUrl(NETWORK), 'confirmed');

async function debugSolanaProgram() {
  console.log('=== Solana Program Debug ===');
  console.log('Network:', NETWORK);
  console.log('Program ID:', PROGRAM_ID.toString());
  console.log('RPC URL:', connection.rpcEndpoint);
  console.log('');

  try {
    // Test połączenia
    console.log('1. Testing connection...');
    const version = await connection.getVersion();
    console.log('✓ Connected to Solana RPC');
    console.log('  Version:', version['solana-core']);
    console.log('');

    // Sprawdź program
    console.log('2. Checking program...');
    const programAccount = await connection.getAccountInfo(PROGRAM_ID);
    
    if (!programAccount) {
      console.log('✗ Program does not exist at address:', PROGRAM_ID.toString());
      return;
    }
    
    console.log('✓ Program found');
    console.log('  Executable:', programAccount.executable);
    console.log('  Owner:', programAccount.owner.toString());
    console.log('  Lamports:', programAccount.lamports);
    console.log('  Data length:', programAccount.data.length);
    console.log('');

    if (!programAccount.executable) {
      console.log('✗ Program is not executable');
      return;
    }

    // Sprawdź przykład PDA
    console.log('3. Testing PDA generation...');
    const testCreator = new PublicKey('11111111111111111111111111111112'); // Przykładowy klucz
    
    try {
      const [pda, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('uno_game'), testCreator.toBuffer()],
        PROGRAM_ID
      );
      
      console.log('✓ PDA generation works');
      console.log('  Test creator:', testCreator.toString());
      console.log('  Generated PDA:', pda.toString());
      console.log('  Bump seed:', bump);
      console.log('');
    } catch (error) {
      console.log('✗ PDA generation failed:', error.message);
      return;
    }

    // Sprawdź słot i inne informacje
    console.log('4. Network info...');
    const slot = await connection.getSlot();
    const blockHeight = await connection.getBlockHeight();
    
    console.log('✓ Network is responsive');
    console.log('  Current slot:', slot);
    console.log('  Block height:', blockHeight);
    console.log('');

    console.log('🎉 All checks passed! Program should be ready to use.');

  } catch (error) {
    console.error('❌ Error during debug:', error);
  }
}

// Uruchom debug
debugSolanaProgram().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});