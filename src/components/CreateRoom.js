import React, { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { createRoom } from '../utils/SolanaTransactions';

function CreateRoom({ onBack, onRoomCreated }) {
  const wallet = useWallet();
  const { publicKey } = wallet;
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [entryFee, setEntryFee] = useState(0.1);
  const [isCreating, setIsCreating] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!publicKey) {
      alert('Portfel nie jest połączony');
      return;
    }

    try {
      setIsCreating(true);
      
      // Sprawdź, czy wallet jest zdefiniowany przed przekazaniem go
      console.log("Wallet object:", wallet); // Dodaj to, aby zobaczyć, co zawiera obiekt wallet
      
      // Przekaż wallet bezpośrednio
      const roomId = await createRoom(maxPlayers, entryFee, wallet);
      onRoomCreated(roomId);
    } catch (error) {
      console.error('Error creating room:', error);
      alert('Błąd podczas tworzenia pokoju: ' + error.message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="create-room">
      <h2>Stwórz nowy pokój</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="maxPlayers">Maksymalna liczba graczy (2-4):</label>
          <input
            type="number"
            id="maxPlayers"
            min="2"
            max="4"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(parseInt(e.target.value))}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="entryFee">Wpisowe (SOL):</label>
          <input
            type="number"
            id="entryFee"
            min="0.01"
            step="0.01"
            value={entryFee}
            onChange={(e) => setEntryFee(parseFloat(e.target.value))}
            required
          />
        </div>
        <div className="form-buttons">
          <button type="button" onClick={onBack}>Wróć</button>
          <button type="submit" disabled={isCreating || !publicKey}>
            {isCreating ? 'Tworzenie...' : 'Stwórz pokój'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateRoom;