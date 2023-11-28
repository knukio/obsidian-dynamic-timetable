import React from 'react';

type BufferTimeRowProps = {
  bufferTime: number | null;
};

const formatTime = (minutes: number): string => {
  const absoluteMinutes = Math.abs(minutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const remainingMinutes = absoluteMinutes % 60;
  const sign = minutes < 0 ? '-' : '';
  return `${sign}${hours}h${remainingMinutes}min`;
};

const BufferTimeRow: React.FC<BufferTimeRowProps> = ({ bufferTime }) => (
  <tr className="buffer-time dt-buffer-time">
    <td>Buffer Time</td>
    <td colSpan={3} style={{ textAlign: 'center' }}>
      {bufferTime !== null ? formatTime(bufferTime) : '0h0min'}
    </td>
  </tr>
);

export default BufferTimeRow;
