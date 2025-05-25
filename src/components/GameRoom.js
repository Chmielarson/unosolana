// src/components/GameRoom.js
import React, { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { 
  getRoomInfo,
  getGameState,
  joinRoom,
  startGame,
  playCard,
  drawCard,
  claimPrize,
  leaveGame,
  endGame,
  autoSkipTurn,
  connectToGameServer,
  listenForGameState,
  getSocket,
  getSocketStatus
} from '../utils/SolanaTransactions';

// Funkcja do obliczania pozostałego czasu na podstawie turnStartTime
const calculateRemainingTime = (turnStartTime, maxTurnTime) => {
  if (!turnStartTime) return maxTurnTime;
  
  const startTime = new Date(turnStartTime).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startTime) / 1000);
  const remainingTime = Math.max(0, maxTurnTime - elapsedSeconds);
  
  return remainingTime;
};

function GameRoom({ roomId, onBack }) {
  const wallet = useWallet();
  const { publicKey } = wallet;
  const [roomInfo, setRoomInfo] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [playerHand, setPlayerHand] = useState([]);
  const [currentCard, setCurrentCard] = useState(null);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [gameStatus, setGameStatus] = useState('waiting'); // waiting, joining, playing, ended
  const [winner, setWinner] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedCard, setSelectedCard] = useState(null);
  const [showColorModal, setShowColorModal] = useState(false);
  const [selectedColor, setSelectedColor] = useState(null);
  const [playerIndex, setPlayerIndex] = useState(-1);
  const [opponentsCards, setOpponentsCards] = useState({});
  const [deckSize, setDeckSize] = useState(0);
  const [direction, setDirection] = useState(1);
  const [lastAction, setLastAction] = useState(null);
  const [lastUpdateTimestamp, setLastUpdateTimestamp] = useState(0);
  const [turnTimer, setTurnTimer] = useState(0);
  const [maxTurnTime] = useState(30); // 30 sekund na ruch
  const [isGameInitialized, setIsGameInitialized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected, connecting, connected
  const [error, setError] = useState(null);
  const [unsubscribeGameState, setUnsubscribeGameState] = useState(null);
  const [blockchainGameEnded, setBlockchainGameEnded] = useState(false);
  const [socket, setSocket] = useState(null);

  // Inicjalizuj socket przy montowaniu
  useEffect(() => {
    console.log('Initializing socket for GameRoom');
    const socketInstance = getSocket();
    setSocket(socketInstance);
    
    // Nasłuchuj na połączenie
    const handleSocketConnect = () => {
      console.log('Socket connected in GameRoom');
      setConnectionStatus('connected');
      // Jeśli już jesteśmy w grze, dołącz ponownie
      if (roomInfo?.gameStarted && publicKey) {
        socketInstance.emit('join_game', {
          roomId,
          gameId: roomInfo.gameId || 'unknown',
          playerAddress: publicKey.toString()
        });
      }
    };
    
    const handleSocketDisconnect = () => {
      console.log('Socket disconnected in GameRoom');
      setConnectionStatus('disconnected');
    };
    
    window.addEventListener('socketConnected', handleSocketConnect);
    window.addEventListener('socketDisconnected', handleSocketDisconnect);
    
    // Sprawdź początkowy status
    const status = getSocketStatus();
    if (status.connected) {
      setConnectionStatus('connected');
    }
    
    return () => {
      window.removeEventListener('socketConnected', handleSocketConnect);
      window.removeEventListener('socketDisconnected', handleSocketDisconnect);
    };
  }, []);

  // Usprawniona funkcja aktualizacji stanu gry
  const updateGameState = useCallback((state) => {
    if (!state) {
      console.error("Received empty game state");
      return;
    }
    
    console.log("Updating game state:", {
      currentPlayer: state.currentPlayerIndex,
      myIndex: playerIndex,
      isMyTurn: state.currentPlayerIndex === playerIndex,
      handSize: state.playerHand?.length,
      timestamp: new Date().toISOString()
    });
    
    // Użyj React.unstable_batchedUpdates dla lepszej wydajności
    ReactDOM.unstable_batchedUpdates(() => {
      setGameState(state);
      
      if (state.playerHand) setPlayerHand(state.playerHand);
      if (state.currentCard) setCurrentCard(state.currentCard);
      if (state.currentPlayerIndex !== undefined) setCurrentPlayerIndex(state.currentPlayerIndex);
      if (state.otherPlayersCardCount) setOpponentsCards(state.otherPlayersCardCount);
      if (state.deckSize !== undefined) setDeckSize(state.deckSize);
      if (state.direction !== undefined) setDirection(state.direction);
      if (state.lastAction) setLastAction(state.lastAction);
      
      // Automatyczne odświeżenie timera
      if (state.turnStartTime) {
        const remaining = calculateRemainingTime(state.turnStartTime, maxTurnTime);
        setTurnTimer(remaining);
      }
      
      // Sprawdź zwycięzcę
      if (state.winner && state.winner !== winner) {
        setWinner(state.winner);
        if (state.isActive === false) {
          setGameStatus('ended');
        }
      }
      
      // Jeśli gra jest nadal aktywna, upewnij się że status to 'playing'
      if (state.isActive === true && gameStatus !== 'playing' && !blockchainGameEnded) {
        setGameStatus('playing');
      }
    });
  }, [playerIndex, winner, gameStatus, blockchainGameEnded, maxTurnTime]);

  // Funkcja łącząca ładowanie informacji o pokoju i stanie gry z deduplikacją
  const loadRoomAndGameInfo = useCallback(async (force = false) => {
    // Zabezpieczenie przed zbyt częstym odświeżaniem (max co 2 sekundy, chyba że wymuszono)
    const now = Date.now();
    if (!force && now - lastUpdateTimestamp < 2000) {
      console.log("Throttling refresh, last update was too recent");
      return;
    }
    
    if (isLoading || isRefreshing) {
      console.log("Already loading/refreshing, skipping");
      return;
    }
    
    try {
      console.log("Loading room and game info for room:", roomId);
      setIsRefreshing(true);
      setError(null);
      setLastUpdateTimestamp(now);
      
      // Załaduj dane pokoju
      const info = await getRoomInfo(roomId);
      console.log("Room info loaded:", info);
      setRoomInfo(info);
      
      // Sprawdź czy gra została zakończona na blockchainie
      if (info.blockchainEnded) {
        setBlockchainGameEnded(true);
      }
      
      if (!publicKey) {
        console.log("No public key available");
        return;
      }
      
      const playerAddr = publicKey.toString();
      const playerIdx = info.players.indexOf(playerAddr);
      setPlayerIndex(playerIdx);
      
      if (playerIdx !== -1) {
        // Gracz jest w pokoju
        if (info.gameStarted) {
          setGameStatus('playing');
          
          // Sprawdź połączenie z serwerem gry
          if (connectionStatus !== 'connected' && socket?.connected) {
            setConnectionStatus('connected');
          }
          
          // Załaduj stan gry
          try {
            const state = await getGameState(roomId, wallet);
            console.log("Game state loaded:", state);
            updateGameState(state);
            setIsGameInitialized(true);
          } catch (gameStateError) {
            console.error('Error loading game state:', gameStateError);
            setError("Błąd ładowania stanu gry. Spróbuj odświeżyć.");
          }
        } else {
          setGameStatus('waiting');
        }
      } else if (info.currentPlayers < info.maxPlayers && !info.gameStarted) {
        setGameStatus('joining');
      } else {
        alert('Nie można dołączyć do tego pokoju');
        onBack();
      }
      
      if (info.winner) {
        setWinner(info.winner);
        setGameStatus('ended');
        
        // Jeśli gra ma zwycięzcę i jest oznaczona jako zakończona na blockchainie
        if (info.blockchainEnded) {
          setBlockchainGameEnded(true);
        }
      }
    } catch (error) {
      console.error('Error loading room info:', error);
      setError("Błąd ładowania informacji o pokoju. Spróbuj ponownie.");
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  }, [roomId, publicKey, wallet, isLoading, isRefreshing, onBack, lastUpdateTimestamp, connectionStatus, socket, updateGameState]);

  // Efekt inicjalizacyjny - uruchamiany tylko raz przy montowaniu komponentu
  useEffect(() => {
    if (!roomId || !publicKey) return;
    
    console.log("Initial data loading for room:", roomId);
    setIsLoading(true);
    
    // Funkcja do jednorazowego załadowania danych
    const loadInitialData = async () => {
      try {
        console.log("Loading initial room info");
        const info = await getRoomInfo(roomId);
        console.log("Initial room info loaded:", info);
        
        // Zapisz dane pokoju w stanie
        setRoomInfo(info);
        
        // Sprawdź czy gracz jest w pokoju
        const playerAddr = publicKey.toString();
        const playerIdx = info.players.indexOf(playerAddr);
        setPlayerIndex(playerIdx);
        
        // Sprawdź czy gra została zakończona na blockchainie
        if (info.blockchainEnded) {
          setBlockchainGameEnded(true);
        }
        
        // Ustal status na podstawie danych pokoju
        if (playerIdx !== -1) {
          if (info.gameStarted) {
            setGameStatus('playing');
            
            // Połącz z serwerem gry
            try {
              setConnectionStatus('connecting');
              await connectToGameServer(roomId, info.gameId || 'unknown', playerAddr);
              setConnectionStatus('connected');
              
              const state = await getGameState(roomId, wallet);
              updateGameState(state);
              setIsGameInitialized(true);
            } catch (error) {
              console.error("Error initializing game:", error);
              setError("Błąd inicjalizacji gry. Spróbuj odświeżyć stronę.");
              setConnectionStatus('disconnected');
            }
          } else {
            setGameStatus('waiting');
          }
        } else if (info.currentPlayers < info.maxPlayers && !info.gameStarted) {
          setGameStatus('joining');
        } else {
          alert('Nie można dołączyć do tego pokoju');
          onBack();
          return;
        }
        
        if (info.winner) {
          setWinner(info.winner);
          setGameStatus('ended');
        }
      } catch (error) {
        console.error("Error loading initial data:", error);
        setError("Błąd ładowania początkowych danych. Spróbuj ponownie.");
      } finally {
        setIsLoading(false);
      }
    };
    
    loadInitialData();
  }, [roomId, publicKey, wallet, onBack]);

  // Osobny useEffect dla game listeners z dependencies na socket
  useEffect(() => {
    if (!socket || !roomId || !publicKey || gameStatus !== 'playing') return;
    
    const playerAddr = publicKey.toString();
    
    console.log('Setting up game listeners, socket status:', getSocketStatus());
    
    // Handler dla aktualizacji stanu gry
    const handleGameStateUpdate = (data) => {
      console.log('[GameRoom] Game state update received:', {
        roomId: data.roomId,
        currentPlayer: data.currentPlayerIndex,
        lastAction: data.lastAction?.action,
        timestamp: new Date().toISOString()
      });
      
      // Zawsze aktualizuj stan, nawet dla własnych ruchów
      // ale oznacz że to własny ruch
      const isMyAction = data.lastAction?.player === playerAddr;
      
      updateGameState(data);
      setLastUpdateTimestamp(Date.now());
      
      // Jeśli to nie mój ruch, pokaż wizualny feedback
      if (!isMyAction && data.lastAction) {
        // Możesz dodać jakiś efekt dźwiękowy lub animację
        console.log('Opponent made a move:', data.lastAction.action);
      }
    };
    
    // Handler dla zakończenia gry
    const handleGameEnded = (data) => {
      console.log("Game ended event:", data);
      setWinner(data.winner);
      setGameStatus('ended');
      
      if (data.blockchainConfirmed) {
        setBlockchainGameEnded(true);
      }
    };
    
    // Handler dla must_end_game_on_chain
    const handleMustEndGame = (data) => {
      console.log("Must end game on chain:", data);
      if (data.winnerAddress === playerAddr) {
        setError("Wygrałeś! Potwierdź zakończenie gry na blockchainie.");
      }
    };
    
    // Handler dla błędów
    const handleGameError = (error) => {
      console.error("Game error:", error);
      setError(error.message || "Wystąpił błąd w grze");
    };
    
    // Ustaw wszystkie handlery
    socket.on('game_state_update', handleGameStateUpdate);
    socket.on('game_state', handleGameStateUpdate); // Dla kompatybilności
    socket.on('game_ended', handleGameEnded);
    socket.on('must_end_game_on_chain', handleMustEndGame);
    socket.on('game_error', handleGameError);
    
    // Dołącz do gry
    console.log('Joining game via socket:', { roomId, playerAddr });
    socket.emit('join_game', {
      roomId,
      gameId: roomInfo?.gameId || 'unknown', 
      playerAddress: playerAddr
    });
    
    // Cleanup
    return () => {
      console.log('Cleaning up game listeners');
      socket.off('game_state_update', handleGameStateUpdate);
      socket.off('game_state', handleGameStateUpdate);
      socket.off('game_ended', handleGameEnded);
      socket.off('must_end_game_on_chain', handleMustEndGame);
      socket.off('game_error', handleGameError);
      socket.emit('leave_game', { roomId, playerAddress: playerAddr });
    };
  }, [socket, roomId, publicKey, gameStatus, roomInfo?.gameId, updateGameState]);

  // Efekt do odliczania czasu dla aktualnego gracza
  useEffect(() => {
    // Uruchamiamy timer tylko gdy jest nasza kolej i gra jest w toku
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex !== playerIndex ||
      !publicKey ||
      connectionStatus !== 'connected' ||
      blockchainGameEnded
    ) {
      setTurnTimer(0);
      return;
    }
    
    console.log("Starting turn timer with turnStartTime:", gameState?.turnStartTime);
    
    // Ustaw początkowy czas na podstawie turnStartTime z serwera
    if (gameState?.turnStartTime) {
      const remainingTime = calculateRemainingTime(gameState.turnStartTime, maxTurnTime);
      setTurnTimer(remainingTime);
      
      // Jeśli czas już minął, automatycznie dobierz kartę
      if (remainingTime <= 0) {
        console.log("Time's up! Auto-drawing card");
        handleDrawCard().catch(error => {
          console.error("Error auto-drawing card:", error);
        });
        return;
      }
    } else {
      setTurnTimer(maxTurnTime);
    }
    
    // Rozpocznij odliczanie
    const interval = setInterval(() => {
      setTurnTimer(prevTime => {
        // Upewnij się, że bazujemy na aktualnym czasie serwerowym
        if (gameState?.turnStartTime) {
          const currentRemaining = calculateRemainingTime(gameState.turnStartTime, maxTurnTime);
          
          // Gdy czas się skończy, automatycznie dobierz kartę
          if (currentRemaining <= 0) {
            clearInterval(interval);
            console.log("Time's up! Auto-drawing card");
            handleDrawCard().catch(error => {
              console.error("Error auto-drawing card:", error);
            });
            return 0;
          }
          
          return currentRemaining;
        } else {
          const newTime = prevTime - 1;
          
          // Gdy czas się skończy, automatycznie dobierz kartę
          if (newTime <= 0) {
            clearInterval(interval);
            console.log("Time's up! Auto-drawing card");
            handleDrawCard().catch(error => {
              console.error("Error auto-drawing card:", error);
            });
            return 0;
          }
          
          return newTime;
        }
      });
    }, 1000);
    
    return () => {
      clearInterval(interval);
    };
  }, [gameStatus, currentPlayerIndex, playerIndex, publicKey, maxTurnTime, gameState?.turnStartTime, connectionStatus, blockchainGameEnded]);
  
  // Efekt do sprawdzania czasu przeciwnika
  useEffect(() => {
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex === playerIndex ||
      !roomId ||
      !wallet ||
      !publicKey ||
      connectionStatus !== 'connected' ||
      blockchainGameEnded
    ) {
      return;
    }
    
    if (!gameState?.turnStartTime) return;
    
    console.log("Monitoring opponent's turn time with turnStartTime:", gameState.turnStartTime);
    
    const remainingTime = calculateRemainingTime(gameState.turnStartTime, maxTurnTime);
    setTurnTimer(remainingTime);
    
    // Jeśli przeciwnik już przekroczył czas, spróbuj odświeżyć stan gry
    if (remainingTime <= 0) {
      console.log("Opponent time's up! Force refreshing game state");
      loadRoomAndGameInfo(true).catch(error => {
        console.error("Error refreshing game state:", error);
      });
      return;
    }
    
    // Sprawdzaj co sekundę, czy przeciwnik nie przekroczył czasu
    const interval = setInterval(async () => {
      const currentRemaining = calculateRemainingTime(gameState.turnStartTime, maxTurnTime);
      
      setTurnTimer(currentRemaining);
      
      // Jeśli czas się skończył, ale nadal jest tura przeciwnika
      if (currentRemaining <= 0) {
        console.log("Opponent time's up! Refreshing game state");
        
        try {
          await loadRoomAndGameInfo(true);
        } catch (error) {
          console.error("Error checking opponent time:", error);
        }
      }
    }, 1000);
    
    return () => clearInterval(interval);
  }, [gameStatus, currentPlayerIndex, playerIndex, roomId, wallet, publicKey, gameState?.turnStartTime, loadRoomAndGameInfo, connectionStatus, maxTurnTime, blockchainGameEnded]);
  
  // Awaryjne odświeżanie co 15 sekund
  useEffect(() => {
    if (gameStatus !== 'playing' || !roomId || !wallet || connectionStatus !== 'connected' || blockchainGameEnded) return;
    
    console.log("Setting up backup refresh interval");
    
    const interval = setInterval(async () => {
      try {
        console.log("Backup refresh - checking game state");
        const state = await getGameState(roomId, wallet);
        updateGameState(state);
      } catch (error) {
        console.error("Error in backup refresh:", error);
      }
    }, 15000);
    
    return () => {
      console.log("Cleaning up backup refresh");
      clearInterval(interval);
    };
  }, [roomId, wallet, gameStatus, connectionStatus, blockchainGameEnded, updateGameState]);

  // Dołączenie do pokoju
  const handleJoinRoom = async () => {
    if (!publicKey) {
      alert('Połącz portfel, aby dołączyć do gry');
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);
      console.log("Joining room:", roomId);

      if (!roomInfo) {
        console.log("No room info available, reloading");
        try {
          const info = await getRoomInfo(roomId);
          setRoomInfo(info);
        } catch (error) {
          console.error("Error loading room info:", error);
          throw new Error('Nie można załadować informacji o pokoju');
        }
      }
      
      if (!roomInfo?.entryFee) {
        throw new Error('Brak informacji o wpisowym');
      }
      
      // Najpierw zabezpieczmy się przed równoległymi żądaniami
      const entryFeeValue = parseFloat(roomInfo.entryFee);
      if (isNaN(entryFeeValue)) {
        throw new Error('Nieprawidłowa kwota wpisowego');
      }
      
      console.log("Entry fee confirmed:", entryFeeValue);
      
      // WAŻNE: Sprawdź, czy już jesteś w pokoju
      const playerAddr = publicKey.toString();
      if (roomInfo.players && roomInfo.players.includes(playerAddr)) {
        console.log("Player already in room, updating status");
        setGameStatus('waiting');
        return;
      }
      
      console.log("Starting join room process with fee:", entryFeeValue);
      
      try {
        const result = await joinRoom(roomId, entryFeeValue, wallet);
        console.log("Join room successful:", result);
        
        setGameStatus('waiting');
        
        // Ręczne odświeżenie po 2 sekundach
        setTimeout(async () => {
          try {
            await loadRoomAndGameInfo(true);
          } catch (refreshError) {
            console.error("Error refreshing room info:", refreshError);
          }
        }, 2000);
      } catch (joinError) {
        console.error("Error in joinRoom:", joinError);
        throw joinError;
      }
    } catch (error) {
      console.error('Error joining room:', error);
      setError(`Błąd podczas dołączania do pokoju: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Rozpoczęcie gry
  const handleStartGame = async () => {
    if (!publicKey || !roomInfo || gameStatus !== 'waiting') {
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);
      console.log("Starting game for room:", roomId);
      
      // Sprawdź, czy jest wystarczająca liczba graczy
      if (roomInfo.players.length < 2) {
        throw new Error('Potrzeba co najmniej 2 graczy, aby rozpocząć grę');
      }
      
      // Wywołaj funkcję startGame, która zapoczątkuje grę on-chain i połączy z serwerem
      const gameId = await startGame(roomId, wallet);
      console.log("Game started with ID:", gameId);
      
      setConnectionStatus('connected');
      setIsGameInitialized(true);
      setGameStatus('playing');
      
      // Odśwież stan gry
      await loadRoomAndGameInfo(true);
    } catch (error) {
      console.error('Error starting game:', error);
      setError(`Błąd podczas rozpoczynania gry: ${error.message}`);
      setConnectionStatus('disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  // Zagranie karty
  const handlePlayCard = async (cardIndex) => {
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex !== playerIndex ||
      connectionStatus !== 'connected' ||
      blockchainGameEnded
    ) {
      // Nie twoja kolej lub gra nie jest aktywna
      return;
    }

    if (!playerHand || !playerHand[cardIndex]) {
      console.error("Próba zagrania nieistniejącej karty:", cardIndex);
      return;
    }

    const card = playerHand[cardIndex];
    
    if (!currentCard) {
      console.error("Brak aktualnej karty na stole");
      return;
    }
    
    // Sprawdzenie, czy ruch jest prawidłowy
    if (
      card.color !== currentCard.color && 
      card.value !== currentCard.value && 
      card.color !== 'black'
    ) {
      alert('Nieprawidłowy ruch! Musisz wybrać kartę o tym samym kolorze lub wartości.');
      return;
    }

    // Jeśli to karta Wild, pokaż modal wyboru koloru
    if (card.color === 'black') {
      setSelectedCard(cardIndex);
      setShowColorModal(true);
      return;
    }

    // Zwykła karta
    try {
      setIsLoading(true);
      setError(null);
      
      // Symuluj efekt zagrania karty - usuń ją z ręki natychmiast w UI
      setPlayerHand(prev => {
        const updatedHand = [...prev];
        updatedHand.splice(cardIndex, 1);
        return updatedHand;
      });
      
      // Wywołaj funkcję zagrania karty przez Socket.IO
      const result = await playCard(roomId, cardIndex, null, wallet);
      console.log("Play card result:", result);
      
      // Jeśli wygrałeś
      if (result.winner === publicKey.toString()) {
        console.log("I won! Game should be ending on blockchain...");
        setWinner(publicKey.toString());
        
        // Jeśli gra została automatycznie zakończona na blockchainie
        if (result.gameEndedOnChain) {
          console.log("Game was ended on blockchain automatically");
          setBlockchainGameEnded(true);
          setGameStatus('ended');
        } else if (result.endGameError) {
          console.error("Failed to end game on blockchain:", result.endGameError);
          setError("Wygrałeś! Ale wystąpił błąd przy kończeniu gry na blockchainie. Spróbuj odebrać nagrodę ręcznie.");
        }
      }
      
      // Odśwież stan gry po zagraniu karty
      setTimeout(async () => {
        try {
          await loadRoomAndGameInfo(true);
        } catch (refreshError) {
          console.error("Error refreshing after play:", refreshError);
        }
      }, 1000);
      
    } catch (error) {
      console.error('Error playing card:', error);
      setError(`Błąd podczas zagrywania karty: ${error.message}`);
      
      // Przywróć poprzedni stan ręki, jeśli wystąpił błąd
      await loadRoomAndGameInfo(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Wybór koloru dla karty Wild
  const handleColorSelect = async (color) => {
    if (selectedCard === null) return;
    
    try {
      setIsLoading(true);
      setError(null);
      setShowColorModal(false);
      
      // Symuluj efekt zagrania karty - usuń ją z ręki natychmiast w UI
      setPlayerHand(prev => {
        const updatedHand = [...prev];
        updatedHand.splice(selectedCard, 1);
        return updatedHand;
      });
      
      // Wywołaj funkcję zagrania karty przez Socket.IO
      const result = await playCard(roomId, selectedCard, color, wallet);
      console.log("Play wild card result:", result);
      
      setSelectedCard(null);
      
      // Jeśli wygrałeś
      if (result.winner === publicKey.toString()) {
        console.log("I won with wild card! Game should be ending on blockchain...");
        setWinner(publicKey.toString());
        
        // Jeśli gra została automatycznie zakończona na blockchainie
        if (result.gameEndedOnChain) {
          console.log("Game was ended on blockchain automatically");
          setBlockchainGameEnded(true);
          setGameStatus('ended');
        } else if (result.endGameError) {
          console.error("Failed to end game on blockchain:", result.endGameError);
          setError("Wygrałeś! Ale wystąpił błąd przy kończeniu gry na blockchainie. Spróbuj odebrać nagrodę ręcznie.");
        }
      }
      
      // Odśwież stan gry
      setTimeout(async () => {
        try {
          await loadRoomAndGameInfo(true);
        } catch (refreshError) {
          console.error("Error refreshing after wild play:", refreshError);
        }
      }, 1000);
      
    } catch (error) {
      console.error('Error playing wild card:', error);
      setError(`Błąd podczas zagrywania karty: ${error.message}`);
      
      // Przywróć poprzedni stan ręki, jeśli wystąpił błąd
      await loadRoomAndGameInfo(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Dobranie karty
  const handleDrawCard = async () => {
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex !== playerIndex ||
      connectionStatus !== 'connected' ||
      blockchainGameEnded
    ) {
      // Nie twoja kolej lub gra nie jest aktywna
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      
      // Wywołaj funkcję dobrania karty przez Socket.IO
      const drawnCard = await drawCard(roomId, wallet);
      console.log("Drawn card:", drawnCard);
      
      // Symuluj efekt dobrania karty - dodaj ją do ręki natychmiast w UI
      if (drawnCard) {
        setPlayerHand(prev => [...prev, drawnCard]);
      }
      
      // Odśwież stan gry
      await loadRoomAndGameInfo(true);
    } catch (error) {
      console.error('Error drawing card:', error);
      setError(`Błąd podczas dobierania karty: ${error.message}`);
      
      // Przywróć poprzedni stan ręki, jeśli wystąpił błąd
      await loadRoomAndGameInfo(true);
    } finally {
      setIsLoading(false);
    }
  };

  // Odebranie nagrody z prowizją 5%
  const handleClaimPrize = async () => {
    if (gameStatus !== 'ended' || winner !== publicKey?.toString() || !blockchainGameEnded) {
      // Tylko zwycięzca może odebrać nagrodę po zakończeniu gry na blockchainie
      console.log("Cannot claim prize:", { 
        gameStatus, 
        winner, 
        myAddress: publicKey?.toString(),
        blockchainGameEnded 
      });
      
      // Jeśli jesteś zwycięzcą ale gra nie została zakończona na blockchainie
      if (winner === publicKey?.toString() && !blockchainGameEnded) {
        setError("Gra musi być najpierw zakończona na blockchainie. Spróbuj zakończyć grę.");
        
        // Spróbuj zakończyć grę
        try {
          setIsLoading(true);
          await endGame(roomId, publicKey.toString(), wallet);
          setBlockchainGameEnded(true);
          await loadRoomAndGameInfo(true);
        } catch (error) {
          console.error("Error ending game:", error);
          setError(`Błąd podczas kończenia gry: ${error.message}`);
        } finally {
          setIsLoading(false);
        }
      }
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const result = await claimPrize(roomId, wallet);
      
      // Wyświetl szczegółowe informacje o nagrodzie
      alert(
        `🎉 Gratulacje! Wygrałeś!\n\n` +
        `💰 Całkowita pula: ${result.totalPrize.toFixed(2)} SOL\n` +
        `🏆 Twoja nagroda (95%): ${result.prize.toFixed(2)} SOL\n` +
        `🏛️ Prowizja platformy (5%): ${result.platformFee.toFixed(2)} SOL\n\n` +
        `Nagroda została przesłana do Twojego portfela!`
      );
      
      onBack(); // Wróć do listy pokojów po odebraniu nagrody
    } catch (error) {
      console.error('Error claiming prize:', error);
      setError(`Błąd podczas odbierania nagrody: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Obsługa przycisku powrotu
  const handleBackButton = async () => {
    // Jeśli gra jest w toku i pokój jest pełny, potwierdzenie
    if (gameStatus === 'playing' && roomInfo?.currentPlayers > 1 && !blockchainGameEnded) {
      const confirmLeave = window.confirm("Czy na pewno chcesz opuścić grę? Spowoduje to automatyczną przegraną i przeciwnik zostanie zwycięzcą!");
      
      if (confirmLeave) {
        try {
          setIsLoading(true);
          setError(null);
          await leaveGame(roomId, wallet);
          
          // Czyszczenie zasobów przed opuszczeniem
          if (unsubscribeGameState) {
            unsubscribeGameState();
          }
          
          onBack();
        } catch (error) {
          console.error("Error leaving game:", error);
          setError(`Wystąpił błąd podczas opuszczania gry: ${error.message}`);
        } finally {
          setIsLoading(false);
        }
        return;
      } else {
        // Użytkownik anulował opuszczenie
        return;
      }
    }
    
    // W innych przypadkach po prostu wróć, ale upewnij się, że zasoby zostaną zwolnione
    if (unsubscribeGameState) {
      unsubscribeGameState();
    }
    
    onBack();
  };

  // Czyszczenie zasobów przy odmontowaniu komponentu
  useEffect(() => {
    return () => {
      // Anuluj wszystkie subskrypcje
      if (unsubscribeGameState) {
        unsubscribeGameState();
      }
      
      console.log("GameRoom component unmounting, cleaning up resources");
    };
  }, [unsubscribeGameState]);

  // Renderowanie karty UNO
  const renderUnoCard = (card, index, isPlayerHand = false) => {
    // Sprawdź, czy karta istnieje
    if (!card) {
      console.error("Próba renderowania karty null lub undefined:", { index, isPlayerHand });
      return null; // Nie renderuj niczego, jeśli karta jest null lub undefined
    }
    
    // Sprawdź, czy karta ma wszystkie wymagane właściwości
    if (!card.color || !card.value) {
      console.error("Karta ma nieprawidłowy format:", card);
      return (
        <div key={`error-card-${index}`} className="uno-card error">
          Błąd
        </div>
      );
    }
    
    const isPlayable = 
      gameStatus === 'playing' && 
      currentPlayerIndex === playerIndex && 
      isPlayerHand &&
      currentCard && // Dodaj sprawdzenie, czy currentCard istnieje
      connectionStatus === 'connected' &&
      !blockchainGameEnded &&
      (card.color === currentCard.color || card.value === currentCard.value || card.color === 'black');
    
    const cardClasses = `uno-card ${card.color} ${isPlayable ? '' : 'disabled'}`;
    
    return (
      <div
        key={`${card.color}-${card.value}-${index}`}
        className={cardClasses}
        onClick={isPlayable ? () => handlePlayCard(index) : undefined}
      >
        {card.value}
      </div>
    );
  };

  // Renderowanie avatara przeciwnika
  const renderOpponent = (index, cardCount) => {
    const isCurrentPlayer = index === currentPlayerIndex;
    
    return (
      <div className={`opponent ${isCurrentPlayer ? 'is-current-player' : ''}`} key={index}>
        <div className="opponent-name">
          Gracz {index + 1}
          {isCurrentPlayer && (
            <>
              <span className="current-player-indicator">Teraz gra</span>
              {isCurrentPlayer && currentPlayerIndex !== playerIndex && (
                <span className="opponent-timer">
                  {turnTimer > 0 ? `Pozostało: ${turnTimer}s` : 'Czas minął!'}
                </span>
              )}
            </>
          )}
        </div>
        <div className="opponent-cards">
          {Array.from({ length: Math.min(cardCount, 7) }).map((_, i) => (
            <div className="opponent-card" key={i}></div>
          ))}
          {cardCount > 7 && <div className="opponent-card-count">+{cardCount - 7}</div>}
        </div>
      </div>
    );
  };

  // Efekt dla ostatniej akcji
  const renderLastAction = () => {
    if (!lastAction) return null;
    
    const playerName = lastAction.player === publicKey?.toString() 
      ? 'Ty' 
      : `Gracz ${roomInfo?.players.indexOf(lastAction.player) + 1}`;
    
    let actionText = '';
    
    if (lastAction.action === 'play') {
      const card = lastAction.card;
      if (card) {
        actionText = `zagrał kartę ${card.value} (${card.color})`;
        
        if (lastAction.result === 'win') {
          actionText += ' i wygrał grę!';
        }
      } else {
        actionText = 'zagrał kartę';
      }
    } else if (lastAction.action === 'draw') {
      actionText = 'dobrał kartę';
    } else if (lastAction.action === 'start') {
      actionText = 'rozpoczął grę';
    } else if (lastAction.action === 'leave') {
      actionText = 'opuścił grę';
      if (lastAction.result === 'opponent_win') {
        actionText += ' - przeciwnik wygrywa przez walkower';
      }
    }
    
    return (
      <div className="last-action">
        {playerName} {actionText}
      </div>
    );
  };

  // Wyświetlanie statusu połączenia
  const renderConnectionStatus = () => {
    if (gameStatus !== 'playing') return null;
    
    return (
      <div className={`socket-status ${connectionStatus}`}>
        {connectionStatus === 'connected' ? 'Połączono' : 
         connectionStatus === 'connecting' ? 'Łączenie...' : 'Rozłączono'}
      </div>
    );
  };

  if (isLoading && !roomInfo) {
    return <div className="loading">Ładowanie pokoju...</div>;
  }

  return (
    <div className="game-room">
      <h2>Pokój #{roomId}</h2>
      
      {/* Wskaźnik odświeżania */}
      {isRefreshing && (
        <div className="refreshing-indicator">
          Aktualizowanie stanu gry...
        </div>
      )}
      
      {/* Wyświetlanie błędów */}
      {error && (
        <div className="error-message">
          <p>{error}</p>
          <button onClick={() => loadRoomAndGameInfo(true)}>Spróbuj ponownie</button>
        </div>
      )}
      
      {/* Status połączenia */}
      {renderConnectionStatus()}
      
      {/* Debug info - tylko w trybie development */}
      {process.env.NODE_ENV === 'development' && (
        <div className="debug-info" style={{
          background: '#f0f0f0', 
          padding: '10px', 
          margin: '10px 0',
          fontSize: '12px',
          fontFamily: 'monospace'
        }}>
          <div>Debug Info:</div>
          <div>gameStatus: {gameStatus}</div>
          <div>isActive: {gameState?.isActive?.toString()}</div>
          <div>winner: {winner || 'none'}</div>
          <div>blockchainGameEnded: {blockchainGameEnded.toString()}</div>
          <div>currentPlayerIndex: {currentPlayerIndex}</div>
          <div>playerIndex: {playerIndex}</div>
          <div>connectionStatus: {connectionStatus}</div>
          <div>playerHand length: {playerHand?.length || 0}</div>
          <div>roomInfo.blockchainEnded: {roomInfo?.blockchainEnded?.toString() || 'unknown'}</div>
          <div>socket connected: {socket?.connected?.toString() || 'no socket'}</div>
        </div>
      )}
      
      {/* Ekran dołączania do pokoju */}
      {gameStatus === 'joining' && (
        <div className="joining-section">
          <p>Wpisowe: {roomInfo?.entryFee} SOL</p>
          <p>Liczba graczy: {roomInfo?.currentPlayers}/{roomInfo?.maxPlayers}</p>
          <button onClick={handleJoinRoom} disabled={isLoading}>
            {isLoading ? 'Dołączanie...' : 'Zapłać wpisowe i dołącz'}
          </button>
          <button onClick={onBack}>Wróć</button>
        </div>
      )}
      
      {/* Ekran oczekiwania na graczy */}
      {gameStatus === 'waiting' && (
        <div className="waiting-section">
          <p>Czekanie na więcej graczy...</p>
          <p>Liczba graczy: {roomInfo ? `${roomInfo.currentPlayers}/${roomInfo.maxPlayers}` : 'Ładowanie...'}</p>
          <p>Twój indeks: {playerIndex !== -1 ? playerIndex + 1 : 'Nie jesteś w tym pokoju'}</p>
          <p>ID pokoju: {roomId}</p>
          
          {roomInfo && roomInfo.players.length >= 2 && playerIndex === 0 && (
            <button 
              onClick={handleStartGame} 
              className="start-game-btn"
              disabled={isLoading}
            >
              {isLoading ? 'Rozpoczynanie...' : 'Rozpocznij grę'}
            </button>
          )}
          
          <button onClick={() => loadRoomAndGameInfo(true)} disabled={isRefreshing}>
            {isRefreshing ? 'Odświeżanie...' : 'Odśwież'}
          </button>
          <button onClick={handleBackButton}>Wróć</button>
        </div>
      )}
      
      {/* Ekran gry */}
      {(gameStatus === 'playing' || gameStatus === 'ended') && (
        <div className="game-section">
          {/* Informacje o grze */}
          <div className="game-info">
            <div>
              <p>Pula: {roomInfo?.entryFee * roomInfo?.currentPlayers} SOL</p>
              <p>Gracze: {roomInfo?.currentPlayers}/{roomInfo?.maxPlayers}</p>
            </div>
            
            <div>
              {gameStatus === 'playing' && !blockchainGameEnded && (
                <p>
                  Obecnie gra: 
                  {currentPlayerIndex === playerIndex
                    ? ' Ty'
                    : ` Gracz ${currentPlayerIndex + 1}`}
                </p>
              )}
              
              {(gameStatus === 'ended' || winner) && (
                <p>
                  Zwycięzca: 
                  {winner === publicKey?.toString()
                    ? ' Ty'
                    : ` Gracz ${
                        roomInfo?.players.indexOf(winner) + 1
                      }`}
                </p>
              )}
            </div>
            
            <div>
              <p>Kierunek: {direction === 1 ? '→' : '←'}</p>
              <p>Kart w talii: {deckSize}</p>
            </div>
          </div>
          
          {/* Informacja o zwycięzcy */}
          {(gameStatus === 'ended' || winner) && (
            <div className="winner-announcement">
              <h3>Gra zakończona!</h3>
              <p>
                {winner === publicKey?.toString()
                  ? 'Gratulacje! Wygrałeś grę!'
                  : `Gracz ${roomInfo?.players.indexOf(winner) + 1} wygrał grę.`}
              </p>
              {winner === publicKey?.toString() && !blockchainGameEnded && (
                <p style={{ marginTop: '10px', fontSize: '14px', color: '#e74c3c' }}>
                  Oczekiwanie na potwierdzenie blockchain...
                </p>
              )}
            </div>
          )}
          
          {/* Ostatnia akcja */}
          {lastAction && (
            <div className="last-action-container">
              {renderLastAction()}
            </div>
          )}
          
          {/* Przeciwnicy */}
          <div className="opponents">
            {roomInfo?.players
              .filter((addr) => addr !== publicKey?.toString())
              .map((addr, idx) => {
                const realIdx = roomInfo.players.indexOf(addr);
                return renderOpponent(
                  realIdx, 
                  opponentsCards[addr] || 0
                );
              })}
          </div>
          
          {/* Plansza gry */}
          <div className="game-area">
            {/* Talia */}
            <div 
              className={`deck ${currentPlayerIndex !== playerIndex && gameStatus === 'playing' ? 'opponent-drawing' : ''}`}
              onClick={currentPlayerIndex === playerIndex && gameStatus === 'playing' && connectionStatus === 'connected' && !blockchainGameEnded ? handleDrawCard : undefined}
              style={{ 
                cursor: currentPlayerIndex === playerIndex && gameStatus === 'playing' && connectionStatus === 'connected' && !blockchainGameEnded
                  ? 'pointer' 
                  : 'default' 
              }}
            >
              <div className="deck-cards">
                <div className="deck-count">{deckSize}</div>
              </div>
            </div>
            
            {/* Aktualna karta */}
            {currentCard ? (
              <div className={`current-card ${lastAction?.action === 'play' ? 'just-played' : ''}`}>
                <div className={`uno-card ${currentCard.color}`}>
                  {currentCard.value}
                </div>
              </div>
            ) : (
              <div className="current-card">
                <div className="uno-card placeholder">
                  Brak karty
                </div>
              </div>
            )}
          </div>
          
          {/* Ręka gracza */}
          <div className="player-info">
            <p>Twoje karty ({playerHand?.length || 0})</p>
            {currentPlayerIndex === playerIndex && gameStatus === 'playing' && !blockchainGameEnded && (
              <>
                <p className="your-turn">Twoja kolej! <span className="timer">{turnTimer}s</span></p>
                {turnTimer <= 10 && (
                  <p className="timer-warning">
                    Pospiesz się! Zostało mało czasu.
                  </p>
                )}
              </>
            )}
          </div>
          
          <div className="player-hand">
            {playerHand && playerHand.length > 0 
              ? playerHand.map((card, index) => card && renderUnoCard(card, index, true))
              : <p>Brak kart</p>}
          </div>
          
          {/* Przyciski */}
          <div className="game-controls">
            <button 
              className="refresh-btn" 
              onClick={() => loadRoomAndGameInfo(true)} 
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Odświeżanie...' : 'Odśwież stan gry'}
            </button>
            
            {gameStatus === 'playing' &&
              currentPlayerIndex === playerIndex && 
              connectionStatus === 'connected' &&
              !blockchainGameEnded && (
                <button 
                  className="draw-card-btn" 
                  onClick={handleDrawCard}
                  disabled={isLoading}
                >
                  {isLoading ? 'Dobieranie...' : 'Dobierz kartę'}
                </button>
              )}
              
            {gameStatus === 'ended' &&
              blockchainGameEnded &&
              winner === publicKey?.toString() && (
                <button
                  className="claim-prize-btn"
                  onClick={handleClaimPrize}
                  disabled={isLoading}
                >
                  {isLoading 
                    ? 'Odbieranie...' 
                    : `Odbierz nagrodę (${(roomInfo?.entryFee * roomInfo?.currentPlayers * 0.95).toFixed(2)} SOL)`
                  }
                </button>
              )}
              
            {/* Przycisk ręcznego zakończenia gry jeśli coś poszło nie tak */}
            {winner === publicKey?.toString() && !blockchainGameEnded && (
              <button
                className="end-game-btn"
                onClick={async () => {
                  try {
                    setIsLoading(true);
                    setError(null);
                    await endGame(roomId, publicKey.toString(), wallet);
                    setBlockchainGameEnded(true);
                    await loadRoomAndGameInfo(true);
                  } catch (error) {
                    console.error("Error ending game manually:", error);
                    setError(`Błąd podczas kończenia gry: ${error.message}`);
                  } finally {
                    setIsLoading(false);
                  }
                }}
                disabled={isLoading}
                style={{
                  backgroundColor: '#f39c12',
                  color: 'white'
                }}
              >
                {isLoading ? 'Kończenie gry...' : 'Zakończ grę na blockchainie'}
              </button>
            )}
          </div>
          
          <button 
            className="back-btn" 
            onClick={handleBackButton}
            disabled={isLoading}
          >
            {isLoading ? 'Wychodzenie...' : gameStatus === 'ended' ? 'Wróć do listy pokojów' : 'Opuść grę'}
          </button>
        </div>
      )}
      
      {/* Modal wyboru koloru dla karty Wild */}
      {showColorModal && (
        <div className="color-modal">
          <div className="color-modal-content">
            <h3>Wybierz kolor</h3>
            <div className="color-choices">
              <div 
                className="color-choice red" 
                onClick={() => handleColorSelect('red')}
              ></div>
              <div 
                className="color-choice blue" 
                onClick={() => handleColorSelect('blue')}
              ></div>
              <div 
                className="color-choice green" 
                onClick={() => handleColorSelect('green')}
              ></div>
              <div 
                className="color-choice yellow" 
                onClick={() => handleColorSelect('yellow')}
              ></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default GameRoom;