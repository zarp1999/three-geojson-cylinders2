import React from 'react';
import './App.css';
import ThreeView from './components/ThreeView.js';

function App() {
  return React.createElement(
    'div',
    { className: 'App' },
    React.createElement('header', { className: 'app-header' }, 'three-geojson-cylinders'),
    React.createElement('div', { className: 'app-content' },
      React.createElement(ThreeView, { geojsonUrl: '/sample.geojson' })
    )
  );
}

export default App;
