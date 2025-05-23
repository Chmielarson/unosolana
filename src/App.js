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
import { initializeSolanaConnection } from './utils/SolanaTransactions';
import './App.css';
import '@solana/wallet-adapter-react-ui/styles.css';

// Globalny handler nieobsłużonych błędów
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled Promise Rejection:', event.reason);
});

// Funkcje pomocnicze do zarządzania stanem pokoju w localStorage
const saveRoomToLocalStorage = (roomId) => {
  if (roomId) {
    localStorage.setItem('uno_current_room', roomId);
    localStorage.setItem('uno_room_timestamp', Date.now().toString());
  }
};

const getRoomFromLocalStorage = () => {
  const roomId = localStorage.getItem('uno_current_room');
  const timestamp = localStorage.getItem('uno_room_timestamp');
  
  // Sprawdź, czy pokój nie jest zbyt stary (30 minut)
  if (roomId && timestamp) {
    const now = Date.now();
    const roomTime = parseInt(timestamp, 10);
    
    // Jeśli pokój jest starszy niż 30 minut, usuń go
    if (now - roomTime > 30 * 60 * 1000) {
      localStorage.removeItem('uno_current_room');
      localStorage.removeItem('uno_room_timestamp');
      return null;
    }
    
    return roomId;
  }
  
  return null;
};

const clearRoomFromLocalStorage = () => {
  localStorage.removeItem('uno_current_room');
  localStorage.removeItem('uno_room_timestamp');
};

// Domyślnie używamy sieci devnet
const network = WalletAdapterNetwork.Devnet;
const endpoint = clusterApiUrl(network);
const wallets = [new PhantomWalletAdapter()];

function App() {
  // Zmiana inicjalizacji stanu, aby sprawdzić localStorage
  const [currentView, setCurrentView] = useState(() => {
    // Sprawdź, czy mamy zapisany pokój
    const savedRoom = getRoomFromLocalStorage();
    return savedRoom ? 'gameRoom' : 'roomsList';
  });
  
  const [currentRoomId, setCurrentRoomId] = useState(() => {
    // Pobierz zapisany pokój z localStorage
    return getRoomFromLocalStorage();
  });
  
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [solanaStatus, setSolanaStatus] = useState({ connected: false, programExists: false });

  // Test połączenia z Solana przy starcie aplikacji
  useEffect(() => {
    const testSolanaConnection = async () => {
      try {
        console.log('Testing Solana connection on app start...');
        const result = await initializeSolanaConnection();
        setSolanaStatus({
          connected: result.connected,
          programExists: result.programExists,
          network: result.network,
          error: result.error
        });
        
        if (result.connected && result.programExists) {
          console.log('✓ Solana connection test passed');
        } else {
          console.warn('⚠️ Solana connection test failed:', result);
        }
      } catch (error) {
        console.error('Error testing Solana connection:', error);
        setSolanaStatus({
          connected: false,
          programExists: false,
          error: error.message
        });
      }
    };

    testSolanaConnection();
  }, []);

  const handleWalletConnection = (connected) => {
    setIsWalletConnected(connected);
  };

  const navigateToCreateRoom = () => {
    if (!isWalletConnected) {
      alert('Połącz portfel, aby stworzyć pokój');
      return;
    }
    
    if (!solanaStatus.connected || !solanaStatus.programExists) {
      alert('Błąd połączenia z blockchainem Solana. Sprawdź konfigurację.');
      return;
    }
    
    setCurrentView('createRoom');
  };

  const navigateToRoomsList = () => {
    // Wyczyść informacje o zapisanym pokoju
    clearRoomFromLocalStorage();
    setCurrentView('roomsList');
    setCurrentRoomId(null); // Upewnij się, że resetujesz ID pokoju
  };

  const joinRoom = (roomId) => {
    if (!isWalletConnected) {
      alert('Połącz portfel, aby dołączyć do pokoju');
      return;
    }
    
    if (!solanaStatus.connected || !solanaStatus.programExists) {
      alert('Błąd połączenia z blockchainem Solana. Sprawdź konfigurację.');
      return;
    }
    
    // Zapisz pokój do localStorage podczas dołączania
    saveRoomToLocalStorage(roomId);
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
              <div className="header-info">
                <WalletConnection onWalletConnection={handleWalletConnection} />
                {/* Status połączenia z Solana */}
                <div className="solana-status">
                  {solanaStatus.connected ? (
                    <span className="status-connected">
                      ✓ Solana {solanaStatus.network}
                      {solanaStatus.programExists ? ' (Program OK)' : ' (Brak programu)'}
                    </span>
                  ) : (
                    <span className="status-disconnected">
                      ✗ Solana ({solanaStatus.error || 'Brak połączenia'})
                    </span>
                  )}
                </div>
              </div>
            </header>

            <main className="app-main">
              {/* Ostrzeżenie o problemach z Solana */}
              {(!solanaStatus.connected || !solanaStatus.programExists) && (
                <div className="solana-warning">
                  <h3>⚠️ Problem z połączeniem blockchain</h3>
                  <p>
                    {!solanaStatus.connected 
                      ? `Nie można połączyć się z siecią Solana: ${solanaStatus.error}`
                      : 'Program UNO nie został znaleziony na blockchainie'
                    }
                  </p>
                  <p>Sprawdź konfigurację w pliku .env lub spróbuj ponownie później.</p>
                </div>
              )}

              {currentView === 'roomsList' && (
                <div className="rooms-view">
                  <RoomsList onJoinRoom={joinRoom} />
                  <button 
                    className="create-room-btn" 
                    onClick={navigateToCreateRoom}
                    disabled={!solanaStatus.connected || !solanaStatus.programExists}
                  >
                    Stwórz nowy pokój
                  </button>
                </div>
              )}

              {currentView === 'createRoom' && (
                <CreateRoom onBack={navigateToRoomsList} onRoomCreated={(roomId) => {
                  // Zapisz pokój do localStorage podczas tworzenia
                  saveRoomToLocalStorage(roomId);
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