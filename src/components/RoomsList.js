// src/components/RoomsList.js
import React, { useState, useEffect } from 'react';
import { getRooms } from '../utils/SolanaTransactions';

function RoomsList({ onJoinRoom }) {
  const [rooms, setRooms] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchRooms = async () => {
      try {
        setIsLoading(true);
        const roomsData = await getRooms();
        setRooms(roomsData);
      } catch (error) {
        console.error('Error fetching rooms:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchRooms();
    
    // Odświeżanie co 5 sekund
    const interval = setInterval(fetchRooms, 5000);
    
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    try {
      setIsLoading(true);
      const roomsData = await getRooms();
      setRooms(roomsData);
    } catch (error) {
      console.error('Error refreshing rooms:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading && rooms.length === 0) {
    return <div className="loading">Ładowanie pokojów...</div>;
  }

  return (
    <div className="rooms-list">
      <h2>Dostępne pokoje</h2>
      {rooms.length === 0 ? (
        <p>Brak dostępnych pokojów. Stwórz pierwszy!</p>
      ) : (
        <ul>
          {rooms.map((room) => (
            <li key={room.id} className="room-item">
              <div className="room-info">
                <h3>Pokój #{room.id}</h3>
                <p>Utworzony przez: {room.creatorAddress.substring(0, 4)}...{room.creatorAddress.substring(room.creatorAddress.length - 4)}</p>
                <p>Gracze: {room.currentPlayers}/{room.maxPlayers}</p>
                <p>Wpisowe: {room.entryFee} SOL</p>
                <p>Pula: {room.pool} SOL</p>
                <p>Status: {room.gameStarted ? 'Gra w toku' : 'Oczekiwanie'}</p>
              </div>
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
            </li>
          ))}
        </ul>
      )}
      <button className="refresh-btn" onClick={handleRefresh}>
        Odśwież listę
      </button>
    </div>
  );
}

export default RoomsList;