import React, { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';

function WalletConnection({ onWalletConnection }) {
  const { connected, publicKey, signTransaction } = useWallet();
  const [walletAddress, setWalletAddress] = useState('');

  useEffect(() => {
    if (connected && publicKey) {
      setWalletAddress(publicKey.toString());
      onWalletConnection(true);
    } else {
      setWalletAddress('');
      onWalletConnection(false);
    }
  }, [connected, publicKey, onWalletConnection]);

  return (
    <div className="wallet-connection">
      <WalletMultiButton />
      {connected && (
        <div className="wallet-info">
          <p>Adres portfela: {walletAddress.substring(0, 4)}...{walletAddress.substring(walletAddress.length - 4)}</p>
        </div>
      )}
    </div>
  );
}

export default WalletConnection;