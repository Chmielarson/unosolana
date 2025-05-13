// src/components/GameRoom.js
import React, { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { joinRoom, getRoomInfo, getGameState, playCard, drawCard, claimPrize } from '../utils/SolanaTransactions';

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

  // Dodaj odświeżanie co 1.5 sekundy
  useEffect(() => {
    if (!roomId || !publicKey) return;

    // Początkowe załadowanie
    setIsLoading(true);
    loadRoomAndGameInfo();

    // Periodyczne odświeżanie
    const interval = setInterval(() => {
      loadRoomAndGameInfo();
    }, 1500); // Szybsze odświeżanie dla lepszej responsywności

    return () => clearInterval(interval);
  }, [roomId, publicKey, loadRoomAndGameInfo]);

  // Aktualizacja stanu gry
  const updateGameState = (state) => {
    if (!state) return;
    
    setGameState(state);
    setPlayerHand(state.playerHand || []);
    setCurrentCard(state.currentCard || null); // Dodaj zabezpieczenie na wypadek, gdyby currentCard było undefined
    setCurrentPlayerIndex(state.currentPlayerIndex || 0);
    setOpponentsCards(state.otherPlayersCardCount || {});
    setDeckSize(state.deckSize || 0);
    setDirection(state.direction || 1);
    setLastAction(state.lastAction || null);
    
    if (state.winner) {
      setWinner(state.winner);
      setGameStatus('ended');
    }
  };

  // Dołączenie do pokoju
  const handleJoinRoom = async () => {
    if (!publicKey) {
      alert('Połącz portfel, aby dołączyć do gry');
      return;
    }
    
    try {
      setIsLoading(true);
      console.log("Joining room:", roomId, "with entry fee:", roomInfo?.entryFee);
      
      if (!roomInfo) {
        console.log("No room info available, reloading");
        await loadRoomAndGameInfo();
        if (!roomInfo) {
          throw new Error('Nie można załadować informacji o pokoju');
        }
      }
      
      console.log("Starting join room process with wallet:", wallet);
      await joinRoom(roomId, roomInfo.entryFee, wallet);
      console.log("Join room successful");
      
      // Reload room info after joining
      console.log("Reloading room info after joining");
      await loadRoomAndGameInfo();
    } catch (error) {
      console.error('Error joining room:', error);
      alert('Błąd podczas dołączania do pokoju: ' + error.message);
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