function calculateLeaveBalance(years) { let base = 24; if (years > 2) { base += (years - 2); } return base; }
module.exports = { calculateLeaveBalance };
