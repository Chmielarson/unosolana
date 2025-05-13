// src/App.js
import React, { useState, useEffect } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';
import RoomsList from './components/RoomsList';
import CreateRoom from './components/CreateRoom';
import GameRoom from './components/GameRoom';
import WalletConnection from './components/WalletConnection';
import './App.css';
import '@solana/wallet-adapter-react-ui/styles.css';

// Globalny handler nieobsłużonych błędów
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason);
});

// Domyślnie używamy sieci devnet
const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);
const wallets = [new PhantomWalletAdapter()];

function App() {
  const [currentView, setCurrentView] = useState('roomsList'); // roomsList, createRoom, gameRoom
  const [currentRoomId, setCurrentRoomId] = useState(null);
  const [isWalletConnected, setIsWalletConnected] = useState(false);

  const handleWalletConnection = (connected) => {
    setIsWalletConnected(connected);
  };

  const navigateToCreateRoom = () => {
    if (!isWalletConnected) {
      alert('Połącz portfel, aby stworzyć pokój');
      return;
    }
    setCurrentView('createRoom');
  };

  const navigateToRoomsList = () => {
    setCurrentView('roomsList');
    setCurrentRoomId(null); // Upewnij się, że resetujesz ID pokoju
  };

  const joinRoom = (roomId) => {
    if (!isWalletConnected) {
      alert('Połącz portfel, aby dołączyć do pokoju');
      return;
    }
    setCurrentRoomId(roomId);
    setCurrentView('gameRoom');
  };

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <div className="app">
            <header className="app-header">
              <h1>UNO na Solanie</h1>
              <WalletConnection onWalletConnection={handleWalletConnection} />
            </header>

            <main className="app-main">
              {currentView === 'roomsList' && (
                <div className="rooms-view">
                  <RoomsList onJoinRoom={joinRoom} />
                  <button className="create-room-btn" onClick={navigateToCreateRoom}>
                    Stwórz nowy pokój
                  </button>
                </div>
              )}

              {currentView === 'createRoom' && (
                <CreateRoom onBack={navigateToRoomsList} onRoomCreated={(roomId) => {
                  setCurrentRoomId(roomId);
                  setCurrentView('gameRoom');
                }} />
              )}

              {currentView === 'gameRoom' && currentRoomId && (
                <GameRoom 
                  roomId={currentRoomId} 
                  onBack={navigateToRoomsList} 
                />
              )}
            </main>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;