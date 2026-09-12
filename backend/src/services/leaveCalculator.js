function calculateLeaveBalance(years) { if (typeof years !== 'number' || years < 0) throw new Error('Invalid input'); let base = 24; if (years > 2) { base += (years - 2); } return base; }
module.exports = { calculateLeaveBalance };
