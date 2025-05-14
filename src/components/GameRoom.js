// src/components/GameRoom.js
import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { joinRoom, getRoomInfo, getGameState, playCard, drawCard, claimPrize } from '../utils/SolanaTransactions';
import { listenForRoom, listenForGameState } from '../firebase';

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

  // Funkcja łącząca ładowanie informacji o pokoju i stanie gry
  const loadRoomAndGameInfo = useCallback(async () => {
    try {
      if (isLoading || isRefreshing) return; // Unikaj wielokrotnych wywołań podczas ładowania
      
      console.log("Loading room info for room:", roomId);
      setIsRefreshing(true);
      const info = await getRoomInfo(roomId);
      console.log("Room info loaded:", info);
      setRoomInfo(info);
      
      if (!publicKey) {
        console.log("No public key available");
        return;
      }
      
      const playerAddr = publicKey.toString();
      console.log("Player address:", playerAddr);
      const playerIdx = info.players.indexOf(playerAddr);
      console.log("Player index in room:", playerIdx);
      setPlayerIndex(playerIdx);
      
      if (playerIdx !== -1) {
        // Już jesteśmy w pokoju
        console.log("Player is in the room");
        if (info.gameStarted) {
          // Gra rozpoczęta - załaduj stan gry
          console.log("Game started, loading game state");
          setGameStatus('playing');
          try {
            const state = await getGameState(roomId, wallet);
            console.log("Game state loaded:", state);
            updateGameState(state);
          } catch (error) {
            console.error('Error loading game state:', error);
          }
        } else {
          console.log("Game not started yet, waiting for more players");
          setGameStatus('waiting');
        }
      } else if (info.currentPlayers < info.maxPlayers && !info.gameStarted) {
        // Możemy dołączyć do pokoju
        console.log("Player can join the room");
        setGameStatus('joining');
      } else {
        // Nie możemy dołączyć - pokój pełny lub gra w toku
        console.log("Cannot join room - full or game in progress");
        alert('Nie można dołączyć do tego pokoju');
        onBack();
      }
      
      if (info.winner) {
        console.log("Game has a winner:", info.winner);
        setWinner(info.winner);
        setGameStatus('ended');
      }
    } catch (error) {
      console.error('Error loading room info:', error);
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  }, [roomId, publicKey, wallet, isLoading, isRefreshing, onBack]);

  // Użyj nasłuchiwaczy do reaktywnego odświeżania zamiast interwałów czasowych
  useEffect(() => {
    if (!roomId || !publicKey) return;

    console.log("Setting up initial room data and listeners");
    
    // Oznacz, że ładowanie się rozpoczęło
    setIsLoading(true);
    
    // Jednorazowe załadowanie danych pokoju
    let initialDataLoaded = false;
    const loadInitialData = async () => {
      if (initialDataLoaded) return;
      
      try {
        console.log("Loading initial room info");
        const info = await getRoomInfo(roomId);
        console.log("Initial room info loaded");
        setRoomInfo(info);
        
        const playerAddr = publicKey.toString();
        const playerIdx = info.players.indexOf(playerAddr);
        setPlayerIndex(playerIdx);
        
        if (playerIdx !== -1) {
          // Już jesteśmy w pokoju
          if (info.gameStarted) {
            setGameStatus('playing');
            try {
              const state = await getGameState(roomId, wallet);
              updateGameState(state);
            } catch (error) {
              console.error('Error loading initial game state:', error);
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
        }
        
        initialDataLoaded = true;
      } catch (error) {
        console.error('Error loading initial room data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    // Załaduj dane początkowe
    loadInitialData();
    
    // Zmienne do przechowywania funkcji anulujących nasłuchiwanie
    let unsubscribeRoom = null;
    let unsubscribeGameState = null;
    
    // Ustaw nasłuchiwacze tylko po załadowaniu początkowych danych
    const setupListeners = () => {
      // Zatrzymaj istniejące nasłuchiwacze, jeśli istnieją
      if (unsubscribeRoom) unsubscribeRoom();
      if (unsubscribeGameState) unsubscribeGameState();
      
      // Nasłuchiwacz danych pokoju - z zabezpieczeniem przed rekurencyjnymi aktualizacjami
      let lastRoomUpdate = Date.now();
      unsubscribeRoom = listenForRoom(roomId, (roomData) => {
        // Ograniczenie częstotliwości aktualizacji
        const now = Date.now();
        if (now - lastRoomUpdate < 500) return;
        lastRoomUpdate = now;
        
        setRoomInfo(prev => {
          // Sprawdź, czy dane faktycznie się zmieniły
          if (JSON.stringify(prev) === JSON.stringify(roomData)) {
            return prev; // Brak zmian, nie aktualizuj stanu
          }
          
          // Poniższe aktualizacje wykonujemy w osobnych setTimeout, 
          // aby uniknąć zbyt wielu aktualizacji stanu w jednym cyklu
          setTimeout(() => {
            // Aktualizacja statusu gry na podstawie danych pokoju
            if (roomData.gameStarted) {
              setGameStatus(prev => prev !== 'playing' ? 'playing' : prev);
            }
            
            if (roomData.winner) {
              setWinner(roomData.winner);
              setGameStatus(prev => prev !== 'ended' ? 'ended' : prev);
            }
            
            // Aktualizacja indeksu gracza
            const playerIdx = roomData.players.indexOf(publicKey.toString());
            setPlayerIndex(prev => prev !== playerIdx ? playerIdx : prev);
          }, 0);
          
          return roomData;
        });
      });
      
      // Nasłuchiwacz stanu gry - z zabezpieczeniem przed rekurencyjnymi aktualizacjami
      let lastGameStateUpdate = Date.now();
      unsubscribeGameState = listenForGameState(roomId, publicKey.toString(), (gameStateData) => {
        // Ograniczenie częstotliwości aktualizacji
        const now = Date.now();
        if (now - lastGameStateUpdate < 500) return;
        lastGameStateUpdate = now;
        
        // Użyj funkcji callback do setState, aby mieć dostęp do poprzedniego stanu
        setGameState(prev => {
          // Sprawdź, czy dane faktycznie się zmieniły
          if (JSON.stringify(prev) === JSON.stringify(gameStateData)) {
            return prev; // Brak zmian, nie aktualizuj stanu
          }
          
          // Bezpieczna aktualizacja pozostałych stanów
          setTimeout(() => updateGameState(gameStateData), 0);
          return gameStateData;
        });
      });
    };
    
    // Poczekaj chwilę przed ustawieniem nasłuchiwaczy, aby początkowe dane miały czas się załadować
    const listenersTimeout = setTimeout(() => {
      setupListeners();
    }, 500);
    
    // Funkcja czyszcząca
    return () => {
      clearTimeout(listenersTimeout);
      if (unsubscribeRoom) unsubscribeRoom();
      if (unsubscribeGameState) unsubscribeGameState();
    };
  }, [roomId, publicKey, wallet, onBack]);  // Usuń loadRoomAndGameInfo z zależności, dodaj wallet i onBack

  // Aktualizacja stanu gry
  const updateGameState = (state) => {
    if (!state) return;
    
    // Najpierw sprawdź, czy dane faktycznie się zmieniły
    if (gameState) {
      const currentStateJSON = JSON.stringify({
        hand: playerHand,
        card: currentCard,
        playerIndex: currentPlayerIndex,
        opponents: opponentsCards,
        deck: deckSize,
        dir: direction,
        action: lastAction
      });
      
      const newStateJSON = JSON.stringify({
        hand: state.playerHand || [],
        card: state.currentCard || null,
        playerIndex: state.currentPlayerIndex || 0,
        opponents: state.otherPlayersCardCount || {},
        deck: state.deckSize || 0,
        dir: state.direction || 1,
        action: state.lastAction || null
      });
      
      // Jeśli stan się nie zmienił, nie aktualizuj niczego
      if (currentStateJSON === newStateJSON) {
        return;
      }
    }
    
    // Aktualizuj stany w requestAnimationFrame, aby uniknąć nadmiernych re-renderów
    requestAnimationFrame(() => {
      // Aktualizacja wszystkich stanów w jednym cyklu renderu
      const updates = {};
      let hasUpdates = false;
      
      // Pomocnicza funkcja do sprawdzania, czy wartość się zmieniła
      const shouldUpdate = (currentVal, newVal) => {
        // Dla prostych typów
        if (typeof newVal !== 'object' || newVal === null) {
          return currentVal !== newVal;
        }
        
        // Dla obiektów i tablic
        return JSON.stringify(currentVal) !== JSON.stringify(newVal);
      };
      
      // Sprawdź i zaktualizuj ręcznie każdy stan, tylko jeśli się zmienił
      if (shouldUpdate(playerHand, state.playerHand || [])) {
        setPlayerHand(state.playerHand || []);
        hasUpdates = true;
      }
      
      if (shouldUpdate(currentCard, state.currentCard || null)) {
        setCurrentCard(state.currentCard || null);
        hasUpdates = true;
      }
      
      if (shouldUpdate(currentPlayerIndex, state.currentPlayerIndex || 0)) {
        setCurrentPlayerIndex(state.currentPlayerIndex || 0);
        hasUpdates = true;
      }
      
      if (shouldUpdate(opponentsCards, state.otherPlayersCardCount || {})) {
        setOpponentsCards(state.otherPlayersCardCount || {});
        hasUpdates = true;
      }
      
      if (shouldUpdate(deckSize, state.deckSize || 0)) {
        setDeckSize(state.deckSize || 0);
        hasUpdates = true;
      }
      
      if (shouldUpdate(direction, state.direction || 1)) {
        setDirection(state.direction || 1);
        hasUpdates = true;
      }
      
      if (shouldUpdate(lastAction, state.lastAction || null)) {
        setLastAction(state.lastAction || null);
        hasUpdates = true;
      }
      
      // Aktualizuj winner i gameStatus tylko jeśli są zmiany
      if (state.winner && winner !== state.winner) {
        setWinner(state.winner);
        setGameStatus('ended');
        hasUpdates = true;
      }
      
      if (hasUpdates) {
        console.log('Game state updated with changes');
      }
    });
  };

  // Dołączenie do pokoju
  const handleJoinRoom = async () => {
    if (!publicKey) {
      alert('Połącz portfel, aby dołączyć do gry');
      return;
    }
    
    try {
      setIsLoading(true);
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
      
      // Uproszczony proces dołączania - jednokrotne wywołanie zamiast kilku wywołań zwrotnych 
      try {
        const result = await joinRoom(roomId, entryFeeValue, wallet);
        console.log("Join room successful:", result);
        
        // Zamiast automatycznego odświeżania tutaj, ręcznie ustawmy stan
        setGameStatus('waiting');
        
        // Ręczne odświeżenie po 1 sekundzie
        setTimeout(async () => {
          try {
            const updatedInfo = await getRoomInfo(roomId);
            setRoomInfo(updatedInfo);
            const playerIdx = updatedInfo.players.indexOf(playerAddr);
            setPlayerIndex(playerIdx);
          } catch (refreshError) {
            console.error("Error refreshing room info:", refreshError);
          }
        }, 1000);
      } catch (joinError) {
        console.error("Error in joinRoom:", joinError);
        throw joinError;
      }
    } catch (error) {
      console.error('Error joining room:', error);
      alert(`Błąd podczas dołączania do pokoju: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Zagranie karty
  const handlePlayCard = async (cardIndex) => {
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex !== playerIndex
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
      await playCard(roomId, cardIndex, null, wallet);
      await loadRoomAndGameInfo();
    } catch (error) {
      console.error('Error playing card:', error);
      alert('Błąd podczas zagrywania karty: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Wybór koloru dla karty Wild
  const handleColorSelect = async (color) => {
    if (selectedCard === null) return;
    
    try {
      setIsLoading(true);
      await playCard(roomId, selectedCard, color, wallet);
      setShowColorModal(false);
      setSelectedCard(null);
      await loadRoomAndGameInfo();
    } catch (error) {
      console.error('Error playing wild card:', error);
      alert('Błąd podczas zagrywania karty: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Dobranie karty
  const handleDrawCard = async () => {
    if (
      gameStatus !== 'playing' ||
      currentPlayerIndex !== playerIndex
    ) {
      // Nie twoja kolej lub gra nie jest aktywna
      return;
    }

    try {
      setIsLoading(true);
      await drawCard(roomId, wallet);
      await loadRoomAndGameInfo();
    } catch (error) {
      console.error('Error drawing card:', error);
      alert('Błąd podczas dobierania karty: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Odebranie nagrody
  const handleClaimPrize = async () => {
    if (gameStatus !== 'ended' || winner !== publicKey.toString()) {
      // Tylko zwycięzca może odebrać nagrodę po zakończeniu gry
      return;
    }

    try {
      setIsLoading(true);
      const result = await claimPrize(roomId, wallet);
      alert(`Gratulacje! Nagroda w wysokości ${result.prize} SOL została przesłana do Twojego portfela.`);
      onBack(); // Wróć do listy pokojów po odebraniu nagrody
    } catch (error) {
      console.error('Error claiming prize:', error);
      alert('Błąd podczas odbierania nagrody: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

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
      <div className="opponent" key={index}>
        <div className="opponent-name">
          Gracz {index + 1}
          {isCurrentPlayer && <span className="current-player-indicator">Teraz gra</span>}
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
    }
    
    return (
      <div className="last-action">
        {playerName} {actionText}
      </div>
    );
  };

  // Dodaj debugowanie dla stanu aplikacji
  useEffect(() => {
    console.log("GameRoom state updated:", {
      roomId,
      gameStatus,
      playerIndex,
      currentPlayerIndex,
      isLoading,
      hasRoomInfo: !!roomInfo,
      playerHandSize: playerHand.length,
      hasCurrentCard: !!currentCard,
      opponentsCount: Object.keys(opponentsCards).length
    });
  }, [roomId, gameStatus, playerIndex, currentPlayerIndex, isLoading, roomInfo, playerHand, currentCard, opponentsCards]);

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
      
      {/* Ekran dołączania do pokoju */}
      {gameStatus === 'joining' && (
        <div className="joining-section">
          <p>Wpisowe: {roomInfo?.entryFee} SOL</p>
          <p>Liczba graczy: {roomInfo?.currentPlayers}/{roomInfo?.maxPlayers}</p>
          <button onClick={handleJoinRoom}>Zapłać wpisowe i dołącz</button>
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
          <button onClick={loadRoomAndGameInfo}>Odśwież</button>
          <button onClick={onBack}>Wróć</button>
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
              {gameStatus === 'playing' && (
                <p>
                  Obecnie gra: 
                  {currentPlayerIndex === playerIndex
                    ? ' Ty'
                    : ` Gracz ${currentPlayerIndex + 1}`}
                </p>
              )}
              
              {gameStatus === 'ended' && (
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
          {gameStatus === 'ended' && (
            <div className="winner-announcement">
              <h3>Gra zakończona!</h3>
              <p>
                {winner === publicKey?.toString()
                  ? 'Gratulacje! Wygrałeś grę!'
                  : `Gracz ${roomInfo?.players.indexOf(winner) + 1} wygrał grę.`}
              </p>
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
            <div className="deck" onClick={currentPlayerIndex === playerIndex ? handleDrawCard : undefined}>
              <div className="deck-cards">
                <div className="deck-count">{deckSize}</div>
              </div>
            </div>
            
            {/* Aktualna karta */}
            {currentCard ? (
              <div className="current-card">
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
            {currentPlayerIndex === playerIndex && gameStatus === 'playing' && (
              <p className="your-turn">Twoja kolej!</p>
            )}
          </div>
          
          <div className="player-hand">
            {playerHand && playerHand.length > 0 
              ? playerHand.map((card, index) => card && renderUnoCard(card, index, true))
              : <p>Brak kart</p>}
          </div>
          
          {/* Przyciski */}
          <div className="game-controls">
            <button className="refresh-btn" onClick={loadRoomAndGameInfo}>
              Odśwież stan gry
            </button>
            
            {gameStatus === 'playing' &&
              currentPlayerIndex === playerIndex && (
                <button className="draw-card-btn" onClick={handleDrawCard}>
                  Dobierz kartę
                </button>
              )}
              
            {gameStatus === 'ended' &&
              winner === publicKey?.toString() && (
                <button
                  className="claim-prize-btn"
                  onClick={handleClaimPrize}
                >
                  Odbierz nagrodę ({roomInfo?.entryFee * roomInfo?.currentPlayers} SOL)
                </button>
              )}
          </div>
          
          <button className="back-btn" onClick={onBack}>
            {gameStatus === 'ended' ? 'Wróć do listy pokojów' : 'Opuść grę'}
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