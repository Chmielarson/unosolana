// src/components/RoomsList.js
import React, { useState, useEffect } from 'react';
import { getRooms } from '../utils/SolanaTransactions';

function RoomsList({ onJoinRoom }) {
  const [rooms, setRooms] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Początkowe pobranie pokojów
    const fetchRooms = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const roomsData = await getRooms();
        setRooms(roomsData);
      } catch (error) {
        console.error('Error fetching rooms:', error);
        setError('Błąd pobierania pokojów. Spróbuj ponownie.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchRooms();
    
    // Ustaw interwał odświeżania zamiast nasłuchiwania Firebase
    const interval = setInterval(() => {
      fetchRooms().catch(error => {
        console.error('Error refreshing rooms:', error);
      });
    }, 10000); // Odświeżaj co 10 sekund
    
    // Sprzątanie - anulowanie interwału przy odmontowaniu komponentu
    return () => {
      clearInterval(interval);
    };
  }, []);

  const handleRefresh = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const roomsData = await getRooms();
      setRooms(roomsData);
    } catch (error) {
      console.error('Error refreshing rooms:', error);
      setError('Błąd odświeżania listy pokojów.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="rooms-list">
      <h2>Dostępne pokoje</h2>
      
      {error && (
        <div className="error-message">
          <p>{error}</p>
          <button onClick={handleRefresh}>Spróbuj ponownie</button>
        </div>
      )}
      
      {isLoading && rooms.length === 0 ? (
        <div className="loading">Ładowanie pokojów...</div>
      ) : rooms.length === 0 ? (
        <div className="empty-list">
          <p>Brak dostępnych pokojów. Stwórz pierwszy!</p>
          <button className="refresh-btn" onClick={handleRefresh}>
            Odśwież listę
          </button>
        </div>
      ) : (
        <>
          <ul className="rooms-list-container">
            {rooms.map((room) => (
              <li key={room.id} className="room-item">
                <div className="room-info">
                  <h3>Pokój #{room.id}</h3>
                  <p>Utworzony przez: {room.creatorAddress.substring(0, 4)}...{room.creatorAddress.substring(room.creatorAddress.length - 4)}</p>
                  <p>Gracze: {room.currentPlayers}/{room.maxPlayers}</p>
                  <p>Wpisowe: {room.entryFee} SOL</p>
                  <p>Pula: {room.pool} SOL</p>
                  <p>Status: {room.gameStarted ? 'Gra w toku' : 'Oczekiwanie'}</p>
                  {room.lastActivity && (
                    <p className="last-activity">
                      Ostatnia aktywność: {new Date(room.lastActivity).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                <div className="room-actions">
                  <button 
                    className="join-btn" 
                    onClick={() => {
                      console.log("Joining room:", room.id);
                      onJoinRoom(room.id);
                    }}
                    disabled={room.currentPlayers >= room.maxPlayers || room.gameStarted}
                  >
                    {room.gameStarted 
                      ? 'Gra w toku' 
                      : room.currentPlayers >= room.maxPlayers 
                        ? 'Pokój pełny' 
                        : 'Dołącz'}
                  </button>
                  {room.currentPlayers === 0 && (
                    <div className="room-empty-info">
                      Pokój może zostać usunięty, jeśli nikt nie dołączy
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="rooms-footer">
            <button className="refresh-btn" onClick={handleRefresh}>
              {isLoading ? 'Odświeżanie...' : 'Odśwież listę'}
            </button>
            <div className="rooms-count">
              Znaleziono {rooms.length} pokojów
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default RoomsList;