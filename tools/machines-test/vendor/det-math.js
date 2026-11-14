/* det-math.js - sin, cos, atan2 and acos built only from + - * / and sqrt, which
   give the same bits on every device. Math.sin and friends do not: each engine
   has its own, so the same machine drifts apart between browsers. These go INTO
   the nape bundle in place of Math's (see build-vendor.sh). Method: fdlibm. */
var DM = ( function ()
{
    var HI = 1.57079632673412561417e+00, LO = 6.07710050650619224932e-11, RT = 6.36619772367581382433e-01;
    var S = [ -1.66666666666666324348e-01, 8.33333333332248946124e-03, -1.98412698298579493134e-04, 2.75573137070700676789e-06, -2.50507602534068634195e-08, 1.58969099521155010221e-10 ];
    var C = [ 4.16666666666666019037e-02, -1.38888888888741095749e-03, 2.48015872894767294178e-05, -2.75573143513906633035e-07, 2.08757232129817482790e-09, -1.13596475577881948265e-11 ];
    var AH = [ 4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00 ];
    var AL = [ 2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17 ];
    var AT = [ 3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01, 9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02, 4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02 ];
    var PI = 3.141592653589793, sqrt = Math.sqrt, round = Math.round;

    function poly( c, z ) { var r = 0; for( var i = c.length - 1; i >= 0; i-- ) r = c[ i ] + z * r; return r; }
    function ksin( x ) { var z = x * x; return x + x * z * poly( S, z ); }
    function kcos( x ) { var z = x * x; return 1 - 0.5 * z + z * z * poly( C, z ); }
    function quad( x ) { var n = round( x * RT ); return { y: x - n * HI - n * LO, q: ( ( n % 4 ) + 4 ) % 4 }; }

    function sin( x )
    {
        var r = quad( x );
        return r.q === 0 ? ksin( r.y ) : r.q === 1 ? kcos( r.y ) : r.q === 2 ? -ksin( r.y ) : -kcos( r.y );
    }
    function cos( x )
    {
        var r = quad( x );
        return r.q === 0 ? kcos( r.y ) : r.q === 1 ? -ksin( r.y ) : r.q === 2 ? -kcos( r.y ) : ksin( r.y );
    }
    function atan( v )
    {
        var neg = v < 0, x = neg ? -v : v, id = -1;
        if( x >= 2.4375 ) { id = 3; x = -1 / x; }
        else if( x >= 1.1875 ) { id = 2; x = ( x - 1.5 ) / ( 1 + 1.5 * x ); }
        else if( x >= 0.6875 ) { id = 1; x = ( x - 1 ) / ( x + 1 ); }
        else if( x >= 0.4375 ) { id = 0; x = ( 2 * x - 1 ) / ( 2 + x ); }
        var z = x * x, p = z * poly( AT, z );
        var r = id < 0 ? x - x * p : AH[ id ] - ( ( x * p - AL[ id ] ) - x );
        return neg ? -r : r;
    }
    function atan2( y, x )
    {
        if( x === 0 ) return y === 0 ? 0 : y > 0 ? PI / 2 : -PI / 2;
        var a = atan( y / x );
        return x > 0 ? a : y >= 0 ? a + PI : a - PI;
    }
    function acos( x ) { return atan2( sqrt( ( 1 - x ) * ( 1 + x ) ), x ); }

    return { sin: sin, cos: cos, atan2: atan2, acos: acos };
} )();
